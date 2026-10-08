"""Runtime checks (health.py): a broken plugin is an alert within minutes, not zeroes on the page."""
import os
import tempfile
import unittest

from logs import Log  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import health
from valheim_gamestats.collector import Valheim

MIN, HOUR = 60, 3600


def check(log, now, expect=None):
    evs = log.events()
    return health.check(evs, Valheim.rebuild(evs, log.at(now)), log.at(now), expect)


def playing(log, a, b, name="Ragnar", combat=True):
    """What a healthy plugin logs for a player from a to b: vitals every minute, movement, picks, now and then a fight."""
    log.minutes(a, b, name, e="peak", i="hp", n=120)
    log.minutes(a, b, name, e="dist", i="foot", n=200)
    log.minutes(a, b, name, e="pick", i="Wood", n=2)
    if combat:
        log.minutes(a, b, name, e="taken", i="", n=5)
    return log


def session(version="1.15.0"):
    return Log().restart(0).plugin(-50, version).spawn(60, "Ragnar", 1001)


class Checks(unittest.TestCase):
    def test_healthy(self):
        log = playing(session(), 90, 4 * HOUR)
        self.assertEqual(check(log, 4 * HOUR, "1.15.0"), {})

    def test_plugin_error_zero_rva(self):
        # the incident: the DLL overwritten while loaded — every hook in it dead, the log says so once per minute
        log = playing(session(), 90, HOUR, combat=False).warn(HOUR - 30, "combat", "Method has zero rva")
        problems = check(log, HOUR)
        self.assertIn("error:combat", problems)
        self.assertIn("restart the server", problems["error:combat"])

    def test_plugin_error_old_is_forgotten(self):
        log = playing(session(), 90, 2 * HOUR).warn(100, "gather", "boom")
        self.assertNotIn("error:gather", check(log, 2 * HOUR))

    def test_quiet_combat(self):
        # the incident without its warning: hours of play and not one combat line
        log = playing(session(), 90, 4 * HOUR, combat=False)
        self.assertIn("quiet:combat", check(log, 4 * HOUR))
        self.assertNotIn("quiet:combat", check(log, 2 * HOUR))  # a quiet evening at the base is not an alert

    def test_quiet_counts_player_hours(self):
        log = session().spawn(70, "Astrid", 1002)
        playing(log, 90, 2 * HOUR, "Ragnar", combat=False)
        playing(log, 90, 2 * HOUR, "Astrid", combat=False)
        self.assertIn("quiet:combat", check(log, 2 * HOUR))

    def test_silent_player(self):
        log = playing(session().spawn(70, "Astrid", 1002), 90, HOUR, "Ragnar")
        self.assertEqual(check(log, HOUR), {"silent": "no plugin line while online: Astrid (59 min)"})

    def test_silent_not_at_login(self):
        log = playing(session(), 90, HOUR).spawn(HOUR - 5 * MIN, "Astrid", 1002)
        self.assertNotIn("silent", check(log, HOUR))

    def test_noplugin(self):
        log = playing(Log().restart(0).spawn(60, "Ragnar", 1001), 90, HOUR)
        self.assertIn("noplugin", check(log, HOUR))

    def test_noplugin_after_restart(self):
        # the plugin ran before the restart and never came back
        log = playing(session(), 90, HOUR).restart(2 * HOUR).spawn(2 * HOUR + 60, "Ragnar", 3003)
        self.assertIn("noplugin", check(log, 3 * HOUR))

    def test_zones_without_zone_line(self):
        # the other incident's guard: with 1.15 running every new zone has a zone line; a zone without one would be
        # credited to everyone online
        log = playing(session(), 90, HOUR).location(600, "Crypt3", 12, -90).zone(700, 13, -90, ["Ragnar"])
        self.assertIn("zones", check(log, HOUR))
        log = playing(session(), 90, HOUR).location(600, "Crypt3", 12, -90).zone(601, 12, -90, ["Ragnar"])
        self.assertNotIn("zones", check(log, HOUR))

    def test_zones_before_1_15_are_fine(self):
        log = playing(session("1.14.0"), 90, HOUR).location(600, "Crypt3", 12, -90)
        self.assertNotIn("zones", check(log, HOUR))

    def test_duplicate(self):
        # the rename's trap: GamestatsEquipment.dll left next to ValheimGamestats.dll, both load
        log = playing(session("1.16.0").plugin(-49, "1.15.0"), 90, HOUR)
        self.assertIn("duplicate", check(log, HOUR))
        self.assertIn("1.16.0, 1.15.0", check(log, HOUR)["duplicate"])

    def test_duplicate_not_across_restarts(self):
        log = playing(session(), 90, HOUR).restart(2 * HOUR).plugin(2 * HOUR - 50, "1.15.0").spawn(2 * HOUR + 60, "Ragnar", 3003)
        playing(log, 2 * HOUR + 90, 3 * HOUR)
        self.assertNotIn("duplicate", check(log, 3 * HOUR))

    def test_duplicate_not_after_a_quick_restart(self):
        log = playing(session(), 90, 5 * MIN).restart(6 * MIN).plugin(6 * MIN - 50 + 1, "1.15.0").spawn(7 * MIN, "Ragnar", 3003)
        playing(log, 8 * MIN, HOUR)
        self.assertNotIn("duplicate", check(log, HOUR))

    def test_version_patch_needs_no_new_plugin(self):
        log = playing(session("1.18.0"), 90, HOUR)
        self.assertNotIn("version", check(log, HOUR, "1.18.1"))

    def test_version(self):
        log = playing(session("1.14.0"), 90, HOUR)
        self.assertEqual(check(log, HOUR, "1.15.0"), {"version": "plugin 1.14.0 running, this release ships 1.15.0"})


class Alerts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.posts = []

    def tearDown(self):
        self.dir.cleanup()

    def run_(self, problems, now, **kw):
        return health.run({"id": "test"}, self.dir.name, problems, "https://example.invalid/hook", now=now,
                          post=lambda url, user, embeds: self.posts.extend(embeds), **kw)

    def titles(self):
        return [p["title"] for p in self.posts]

    def test_alert_after_persisting(self):
        for i in range(health.PERSIST):
            self.run_({"silent": "x"}, 1000 + i * 60)
        self.assertEqual(self.titles(), ["⚠ test: silent"])

    def test_alert_plugin_error_at_once(self):
        self.run_({"error:combat": "zero rva"}, 1000)
        self.assertEqual(self.titles(), ["⚠ test: error:combat"])

    def test_alert_flapping_is_quiet(self):
        for i in range(10):
            self.run_({"silent": "x"} if i % 2 else {}, 1000 + i * 60)
        self.assertEqual(self.posts, [])

    def test_alert_resolved(self):
        self.run_({"error:combat": "zero rva"}, 1000)
        self.run_({}, 1060)
        self.assertEqual(self.titles(), ["⚠ test: error:combat", "✓ test: error:combat resolved"])

    def test_alert_reminds(self):
        for t in range(1000, 1000 + health.REMIND + 120, 60):
            self.run_({"error:combat": "zero rva"}, t)
        self.assertEqual(len(self.posts), 2)

    def test_alert_partial_resolves_nothing(self):
        self.run_({"error:combat": "zero rva"}, 1000)
        self.run_({"collector:events": "rcon down"}, 1060, partial=True)
        self.assertEqual(self.titles(), ["⚠ test: error:combat"])

    def test_alert_without_webhook_logs(self):
        posts = health.run({"id": "test"}, self.dir.name, {"error:x": "y"}, "", now=1000,
                           post=lambda *a: self.fail("posted without a webhook"))
        self.assertEqual(len(posts), 1)
        self.assertTrue(os.path.exists(os.path.join(self.dir.name, "health.json")))


if __name__ == "__main__":
    unittest.main()
