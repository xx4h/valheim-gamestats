"""Fetching from the plugin's store (events.py) and building from its events: every event once, gaps and replaced
stores noticed, the old archive joined up to the store's first event, and what the store tells that the log didn't."""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from logs import Log  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import events, health
from valheim_gamestats.collector import Valheim

T0 = 1_790_000_000
SERVER = {"id": "test", "rcon": {"host": "game", "port": 25575, "password_env": "X"}}


class Store:
    """The plugin's store as gs_events answers (plugin/EventStore.cs: After), small replies to make it page."""

    def __init__(self, sid="store-a", max_reply=300):
        self.id, self.lines, self.oldest, self.max_reply = sid, [], 1, max_reply

    def add(self, t, **ev):
        body = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
        self.lines.append(f'{{"s":{len(self.lines) + 1},"t":{int((T0 + t) * 1000)},' + body[1:])
        return self

    def after(self, cursor):
        out = json.dumps({"id": self.id, "head": len(self.lines), "oldest": self.oldest}, separators=(",", ":"))
        for line in self.lines[max(cursor, self.oldest - 1):]:
            if len(out) + len(line) + 1 > self.max_reply:
                break
            out += "\n" + line
        return out

    def rcon(self, host, port, password, cmd, timeout=10):
        assert cmd.startswith("gs_events ")
        return [self.after(int(cmd.split()[1]))]


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = events.open_db(self.dir)

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.dir)

    def sync(self, store):
        with mock.patch.object(events.rcon, "command", store.rcon):
            return events.sync(SERVER, self.db, "pw")


class Sync(Base):
    def test_every_event_once(self):
        store = Store()
        for i in range(40):
            store.add(i, e="pick", p="Ragnar", i="Wood", n=i + 1)
        st = self.sync(store)
        self.assertEqual((st["added"], st["head"]), (40, 40))
        self.assertEqual([e["n"] for e in events.load(self.db)], list(range(1, 41)))
        store.add(50, e="kill", p="Ragnar", i="Troll", n=1)
        self.assertEqual(self.sync(store)["added"], 1)
        self.assertEqual(self.sync(store)["added"], 0)

    def test_own_s_field(self):
        # a sprint's "s" (seconds) after the store's "s" (number): JSON would keep the last
        store = Store().add(1, e="sprint", p="Ragnar", n=1, m=30.4, s=5)
        self.sync(store)
        ev, = events.load(self.db)
        self.assertEqual((ev["e"], ev["s"], ev["t"]), ("sprint", 5, T0 + 1))
        self.assertEqual(events.meta(self.db, "cursor"), 1)

    def test_gap(self):
        store = Store()
        for i in range(10):
            store.add(i, e="pick", p="Ragnar", i="Wood", n=1)
        self.sync(store)
        for i in range(10, 20):
            store.add(i, e="pick", p="Ragnar", i="Wood", n=1)
        store.oldest = 15  # 11–14 pruned before they were read
        st = self.sync(store)
        self.assertEqual((st["gaps"], st["added"]), ([[11, 14]], 6))

    def test_new_store(self):
        self.sync(Store().add(1, e="pick", p="Ragnar", i="Wood", n=1).add(2, e="pick", p="Ragnar", i="Wood", n=1))
        st = self.sync(Store("store-b").add(3, e="pick", p="Astrid", i="Stone", n=1))
        self.assertEqual((st["new_store"], st["added"]), ("store-b", 1))
        self.assertEqual(len(events.load(self.db)), 3)  # the old store's events stay

    def test_store_lost_events(self):
        store = Store()
        for i in range(5):
            store.add(i, e="pick", p="Ragnar", i="Wood", n=1)
        self.sync(store)
        store.lines = store.lines[:3]  # the same store, but it has fewer than we read
        self.assertEqual(self.sync(store)["behind"], [3, 5])

    def test_no_plugin(self):
        with mock.patch.object(events.rcon, "command", lambda *a, **k: ["Unknown command gs_events"]):
            with self.assertRaisesRegex(RuntimeError, "plugin"):
                events.sync(SERVER, self.db, "pw")

    def test_files_while_rcon_is_down(self):
        store = Store()
        for i in range(5):
            store.add(i, e="pick", p="Ragnar", i="Wood", n=1)

        class Pelican:
            def list(self, d):
                return {"store-id": {}, "2026-09-21.jsonl": {}}

            def get(self, path):
                return {"store-id": store.id + "\n",
                        "2026-09-21.jsonl": "\n".join(store.lines) + "\n{\"s\":6,\"t\":1,\"e\":\"pi"}[
                    path.rsplit("/", 1)[1]].encode()

        st = events.sync_files(SERVER, self.db, Pelican())
        self.assertEqual((st["added"], st["files"]), (5, True))
        store.add(9, e="kill", p="Ragnar", i="Neck", n=1)
        self.assertEqual(self.sync(store)["added"], 1)  # RCON back: carries on from the same number

    def test_archive_up_to_the_store(self):
        # the log archive covers everything until the plugin's store began; from there the store is the source
        log = Log().restart(0).spawn(60, "Ragnar", 1001).g(120, e="kill", p="Ragnar", i="Neck", n=1)
        log.g(5000, e="kill", p="Ragnar", i="Neck", n=1)  # also in the store: must not count twice
        with open(os.path.join(self.dir, "archive.jsonl"), "w") as f:
            for row in sorted(log.rows):
                f.write(json.dumps(row) + "\n")
        self.assertEqual(events.import_archive(self.db, self.dir), 0)  # nothing before the store's first event is known
        self.sync(Store().add(4000, e="plugin", p="", i="1.17.0", n=1).add(5000, e="kill", p="Ragnar", i="Neck", n=1))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertGreater(events.import_archive(self.db, self.dir), 0)
            self.assertEqual(events.import_archive(self.db, self.dir), 0)  # once
        kills = [e for e in events.load(self.db) if e["e"] == "kill"]
        self.assertEqual([round(e["t"] - T0) for e in kills], [120, 5000])


class FromTheStore(unittest.TestCase):
    """What the store says that the log never did."""

    def events(self, store):
        return [events.parse_store_line(line)[1] for line in store.lines]

    def test_login_names_the_account(self):
        st = Store().add(0, e="start", p="", i="World", n=1, game="l-1.0.17")
        st.add(60, e="login", p="Ragnar", i="Steam_76561190000000001", n=1, uid=1001).add(60, e="spawn", p="Ragnar", i="", n=1,
                                                                                         uid=1001)
        data = Valheim.rebuild(self.events(st), T0 + 600)
        self.assertEqual(dict(data["_votes"]), {("76561190000000001", "Ragnar"): 1})
        self.assertEqual((data["version"], data["online"]), ("l-1.0.17", ["Ragnar"]))

    def test_stop_ends_sessions_at_once(self):
        st = Store().add(0, e="start", p="", i="W", n=1).add(60, e="spawn", p="Ragnar", i="", n=1, uid=1001)
        st.add(3000, e="stop", p="", i="", n=1).add(3300, e="plugin", p="", i="1.17.0", n=1).add(3350, e="start", p="", i="W",
                                                                                                n=1)
        s, = Valheim.rebuild(self.events(st), T0 + 4000)["sessions"]
        self.assertEqual((s["e"], s["end"]), (T0 + 3000, "restart"))

    def test_death_and_logout(self):
        st = Store().add(0, e="start", p="", i="W", n=1).add(60, e="spawn", p="Ragnar", i="", n=1, uid=1001)
        st.add(500, e="death", p="Ragnar", i="", n=1, uid=1001, x=-120, z=455).add(530, e="spawn", p="Ragnar", i="", n=1,
                                                                                  uid=1001)
        st.add(900, e="logout", p="Ragnar", i="", n=1, uid=1001)
        data = Valheim.rebuild(self.events(st), T0 + 1000)
        s, = data["sessions"]
        self.assertEqual((s["e"], s["end"], s["deaths"], s["spawns"]), (T0 + 900, "logout", 1, 2))
        self.assertEqual(data["deaths"], [{"p": "Ragnar", "t": T0 + 500}])

    def test_raid_near(self):
        st = Store().add(0, e="spawn", p="Ragnar", i="", n=1, uid=1).add(0, e="spawn", p="Astrid", i="", n=1, uid=2)
        st.add(100, e="raid", p="", i="army_eikthyr", n=1, x=10, z=20, near=["Ragnar"])
        raid, = Valheim.rebuild(self.events(st), T0 + 600)["raids"]
        self.assertEqual((raid["players"], raid["near"]), (["Astrid", "Ragnar"], ["Ragnar"]))

    def test_server_samples_and_clock(self):
        st = Store()
        for m in range(30):
            st.add(m * 60, e="server", p="", i="", n=1 if 10 <= m < 20 else 0, zdos=1000, time=500000 + m * 60)
        data = Valheim.rebuild(self.events(st), T0 + 1800)
        self.assertEqual([s[1] for s in data["samples"]], [0, 1, 0])  # every 10 min, and when players come and go
        self.assertEqual((data["clock"]["time"], data["clock"]["src"]), (500000 + 29 * 60, "server"))

    def test_sleep_day(self):
        st = Store().add(0, e="sleep", p="", i="", n=1, time=7394.8, to=7470.0)  # the game's log said day:3
        data = Valheim.rebuild(self.events(st), T0 + 60)
        self.assertEqual((data["days"][0]["d"], data["clock"]["time"]), (3, 7470.0))

    def test_zone_with_its_location(self):
        st = Store().add(0, e="zone", p="", i="12,-9", n=1, by=["Ragnar"], l=["Crypt3"])
        z, = Valheim.rebuild(self.events(st), T0 + 60)["zones"]
        self.assertEqual((z["by"], z["l"], z["exact"]), (["Ragnar"], ["Crypt3"], True))

    def test_bookkeeping_is_not_gathered(self):
        st = Store()
        for e in ("plugin", "start", "stop", "login", "logout", "warn", "raidend", "server", "sleep", "lobby", "gone"):
            st.add(0, e=e, p="", i="x", n=1, uid=1, zdos=1, time=1, to=2, msg="m")
        self.assertEqual(Valheim.rebuild(self.events(st), T0 + 60)["gather"], [])


class Health(unittest.TestCase):
    def check(self, store, now, status=None, expect=None, src=None):
        evs = [events.parse_store_line(line)[1] for line in store.lines]
        return health.check(evs, Valheim.rebuild(evs, T0 + now), T0 + now, expect, status, src)

    def test_warn_events(self):
        st = Store().add(0, e="plugin", p="", i="1.17.0", n=1).add(10, e="start", p="", i="W", n=1)
        st.add(100, e="warn", p="", i="patch", n=1, msg="ZoneGeneratedPatch: no method SetZoneGenerated")
        self.assertIn("ZoneGeneratedPatch", self.check(st, 200)["error:patch"])
        self.assertNotIn("error:patch", self.check(st, 100 + 31 * 60))

    def test_crash(self):
        st = Store().add(0, e="plugin", p="", i="1.17.0", n=1).add(10, e="start", p="", i="W", n=1)
        st.add(5000, e="plugin", p="", i="1.17.0", n=1).add(5050, e="start", p="", i="W", n=1)  # no stop before
        self.assertIn(f"crash:{T0 + 5050}", self.check(st, 5100))
        st2 = Store().add(0, e="plugin", p="", i="1.17.0", n=1).add(10, e="start", p="", i="W", n=1).add(4900, e="stop", p="",
                                                                                                         i="", n=1)
        st2.add(5000, e="plugin", p="", i="1.17.0", n=1).add(5050, e="start", p="", i="W", n=1)
        self.assertEqual([k for k in self.check(st2, 5100) if k.startswith("crash")], [])

    def boot(self, version="1.19.0", **plugin):
        return Store().add(0, e="plugin", p="", i=version, n=1, **plugin).add(10, e="start", p="", i="W", n=1)

    def test_hooks_missing(self):
        st = self.boot(hooks=11, of=12, failed=["ZoneGeneratedPatch"])
        self.assertIn("ZoneGeneratedPatch", self.check(st, 100)["hooks"])
        self.assertNotIn("hooks", self.check(self.boot(hooks=12, of=12, failed=[]), 100))

    def test_heartbeat(self):
        st = self.boot()
        for m in range(1, 5):
            st.add(10 + m * 60, e="server", p="", i="", n=0, zdos=1, time=1)
        self.assertNotIn("heartbeat", self.check(st, 300))
        self.assertIn("heartbeat", self.check(st, 600))
        self.assertNotIn("heartbeat", self.check(st, 600, {"rcon_error": "down"}))  # the server is down, not the plugin

    def online(self, *names):
        st = self.boot()
        for i, n in enumerate(names):
            st.add(60, e="spawn", p=n, i="", n=1, uid=i + 1)
        for m in range(1, 10):
            st.add(10 + m * 60, e="server", p="", i="", n=len(names), zdos=1, time=1)
        return st

    def test_missed_login(self):
        src = {"connected": (T0 + 590, ["Astrid", "Ragnar"])}
        self.assertIn("Astrid", self.check(self.online("Ragnar"), 600, src=src)["missed:login"])
        self.assertNotIn("missed:login", self.check(self.online("Ragnar", "Astrid"), 600, src=src))
        self.assertNotIn("missed:login",
                         self.check(self.online("Ragnar"), 600, src={"connected": (T0, ["Astrid", "Ragnar"])}))  # stale poll

    def test_missed_logout(self):
        src = {"connected": (T0 + 590, [])}
        self.assertIn("Ragnar", self.check(self.online("Ragnar"), 600, src=src)["missed:logout"])

    def test_missed_death(self):
        st = self.online("Ragnar")
        tomb = {"tombs": [(T0 + 400, "Ragnar")]}
        self.assertIn("Ragnar", self.check(st, 600, src=tomb)["missed:death"])
        st.add(395, e="death", p="Ragnar", i="", n=1, uid=1, x=0, z=0)
        self.assertNotIn("missed:death", self.check(st, 600, src=tomb))
        late = {"tombs": [(T0 + 590, "Ragnar")]}  # first seen long after the death (the collector was down): still counted
        self.assertNotIn("missed:death", self.check(st, 600, src=late))

    def test_missed_zones(self):
        st = self.online("Ragnar").add(200, e="zone", p="", i="1,1", n=1, by=["Ragnar"]).add(210, e="zone", p="", i="1,2", n=1,
                                                                                           by=["Ragnar"])
        self.assertIn("3 new zones", self.check(st, 600, src={"saves": [(T0 + 100, 500), (T0 + 400, 503)]})["missed:zones"])
        self.assertNotIn("missed:zones", self.check(st, 600, src={"saves": [(T0 + 100, 500), (T0 + 400, 502)]}))

    def test_unjoinable(self):
        def boot(*lobby, backend="PlayFab"):
            st = Store().add(0, e="plugin", p="", i="1.20.0", n=1).add(10, e="start", p="", i="W", n=1, backend=backend)
            for state, t in lobby:
                st.add(t, e="lobby", p="", i=state, n=1, code="017990",
                       **({"msg": "activate lobby"} if state == "failed" else {}))
            return st
        self.assertNotIn("unjoinable", self.check(boot(), 120))  # still starting
        self.assertIn("isn't active", self.check(boot(), 300)["unjoinable"])  # 2026-10-07: the session never activated
        self.assertNotIn("unjoinable", self.check(boot(("active", 15)), 300))
        self.assertIn("activate lobby", self.check(boot(("failed", 15)), 60)["unjoinable"])
        self.assertNotIn("unjoinable", self.check(boot(backend="Steamworks"), 300))  # no crossplay: no PlayFab session
        # a restart starts over: the old boot's session says nothing about the new one
        st = boot(("active", 15)).add(4000, e="plugin", p="", i="1.20.0", n=1).add(4010, e="start", p="", i="W", n=1,
                                                                                  backend="PlayFab")
        self.assertIn("unjoinable", self.check(st, 4300))

    def test_from_the_fetch(self):
        st = Store().add(0, e="plugin", p="", i="1.17.0", n=1).add(10, e="start", p="", i="W", n=1)
        p = self.check(st, 100, {"gaps": [[11, 14]], "rcon_error": "OSError: connection refused", "new_store": "b"})
        self.assertEqual((p["gap"], "rcon" in p, "store" in p), ("4 event(s) missing from the plugin's store: 11–14", True, True))
        self.assertIn("noplugin", self.check(st, 100, {"rcon_error": "RuntimeError: gs_events: 'Unknown command' — "
                                                                     "is the plugin (1.16.0+) loaded?"}))


if __name__ == "__main__":
    unittest.main()
