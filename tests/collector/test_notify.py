"""The Discord feed (notify.py) over several runs: history isn't news, news is posted once, standings and cards wait
out the debounce, a failed post is tried again, the weekly recap fits Discord's limits."""
import contextlib
import io
import json
import os
import shutil
import unittest
import urllib.error
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

import test_golden
from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import notify

DAY = 86400
SERVER = {"id": "test", "notify": {"url": "https://stats.example.com/", "webhook_env": "GS_TEST_DISCORD"}}


class Feed(unittest.TestCase):
    def setUp(self):
        self.now = test_golden.Log().at(DAY + 3 * 3600)
        self.data, self.sdir, self.dir = test_golden.build(self.now)
        self.posts, self.fail = [], None

    def tearDown(self):
        shutil.rmtree(self.dir)

    def post(self, url, user, embeds):
        if self.fail:
            raise self.fail
        self.posts.append((user, embeds))

    def run_feed(self, data=None, dt=0, env=True):
        data = json.loads(json.dumps(data or self.data))
        data["generated"] = self.now + dt
        self.posts = []
        with mock.patch.object(notify, "post", self.post), mock.patch.object(notify.time, "sleep", lambda s: None), \
                mock.patch.dict(os.environ, {"GS_TEST_DISCORD": "https://discord.invalid/hook"} if env else {}), \
                contextlib.redirect_stdout(io.StringIO()):
            notify.run(SERVER, self.sdir, data)
        return [e for _, embeds in self.posts for e in embeds]

    def titles(self, embeds):
        return [e["title"] for e in embeds]

    def test_history_is_not_news(self):
        self.assertEqual(self.run_feed(), [])
        state = read_json(os.path.join(self.sdir, "notify.json"))
        self.assertEqual(sorted(state["kinds"]), sorted(notify.KINDS))
        self.assertTrue(state["standings"])

    def test_a_new_raid_once(self):
        self.run_feed()
        later = json.loads(json.dumps(self.data))
        later["raids"].append({"t": self.now + 60, "n": "army_eikthyr", "players": ["Bjorn"]})
        posted = self.run_feed(later, dt=120)
        self.assertEqual(self.titles(posted), ["🛡️ Raid! Eikthyr rallies the creatures of the forest"])
        self.assertIn("Bjorn", posted[0]["description"])
        self.assertEqual(self.run_feed(later, dt=180), [])  # once

    def test_a_new_player(self):
        self.run_feed()
        later = json.loads(json.dumps(self.data))
        later["sessions"].append({"p": "Sigrid", "s": self.now + 30, "e": None, "end": "online", "deaths": 0, "spawns": 1})
        self.assertIn("👋 A new Viking arrives!", self.titles(self.run_feed(later, dt=60)))

    def test_title_changes_after_the_debounce(self):
        self.run_feed()
        path = os.path.join(self.sdir, "notify.json")
        state = read_json(path)
        key = next(k for k in state["standings"] if k.startswith("award:"))
        state["standings"][key] = [["Nobody"], 1]  # the title was someone else's
        with open(path, "w") as f:
            json.dump(state, f)
        self.assertEqual(self.run_feed(dt=60), [])  # changed, not yet held for DEBOUNCE
        posted = self.run_feed(dt=60 + notify.DEBOUNCE)
        self.assertEqual(len(posted), 1)
        self.assertIn("takes the title from", posted[0]["description"])

    def test_medal_shake_up(self):
        self.run_feed()
        path = os.path.join(self.sdir, "notify.json")
        state = read_json(path)
        key = next(k for k in state["standings"] if k.startswith("medal:") and state["standings"][k])
        state["standings"][key] = [[1, ["Nobody"]]]
        with open(path, "w") as f:
            json.dump(state, f)
        self.run_feed(dt=60)
        posted = self.run_feed(dt=60 + notify.DEBOUNCE)
        self.assertEqual(self.titles(posted), ["🏆 Leaderboard shake-up"])
        self.assertIn("takes 🥇", posted[0]["description"])

    def test_cards_only_evolve(self):
        self.run_feed()
        stats = {"raids": 80, "survival": 80, "building": 80, "exploring": 80}
        better = lambda c, P, w: {"Ragnar": ("epic", stats)}
        with mock.patch.object(notify, "card_tiers", better):
            self.assertEqual(self.run_feed(dt=60), [])
            posted = self.run_feed(dt=60 + notify.DEBOUNCE)
        self.assertEqual(self.titles(posted), ["🃏 Ragnar's trading card evolved to ★★★ Epic!"])
        worse = lambda c, P, w: {"Ragnar": ("common", stats)}
        with mock.patch.object(notify, "card_tiers", worse):
            self.assertEqual(self.run_feed(dt=120 + 2 * notify.DEBOUNCE), [])  # a drop is no news
        self.assertEqual(read_json(os.path.join(self.sdir, "notify.json"))["cards"]["Ragnar"]["tier"], "epic")

    def test_failed_post_is_tried_again(self):
        self.run_feed()
        later = json.loads(json.dumps(self.data))
        later["raids"].append({"t": self.now + 60, "n": "army_eikthyr", "players": []})
        self.fail = urllib.error.URLError("down")
        self.run_feed(later, dt=120)
        self.fail = None
        self.assertEqual(len(self.run_feed(later, dt=180)), 1)

    def test_ten_per_message(self):
        self.run_feed()
        later = json.loads(json.dumps(self.data))
        for i in range(12):
            later["raids"].append({"t": self.now + 60 + i, "n": "army_eikthyr", "players": []})
        self.run_feed(later, dt=120)
        self.assertEqual([len(e) for _, e in self.posts], [10, 2])

    def test_without_webhook(self):
        self.assertIsNone(self.run_feed(env=False) or None)
        self.assertEqual(self.posts, [])
        self.assertFalse(os.path.exists(os.path.join(self.sdir, "notify.json")))

    def test_weekly_recap(self):
        self.run_feed()  # Tuesday: learns everything there is
        tz = ZoneInfo(self.data["tz"])
        sunday = datetime(2026, 9, 27, 16, 30, tzinfo=tz).timestamp()  # the Sunday after the scenario, after 16:00
        posted = [e for e in self.run_feed(dt=sunday - self.now) if "recap" in e["title"]]
        self.assertEqual(len(posted), 1)
        r = posted[0]
        self.assertTrue(r["title"].startswith("📜 Week 39 recap"))
        self.assertIn("played by **3** Vikings", r["description"])
        # Discord's limits: 25 fields, 1024 per field value, 6000 per embed
        self.assertLessEqual(len(r.get("fields", [])), 25)
        self.assertTrue(all(len(f["value"]) <= 1024 for f in r.get("fields", [])))
        size = len(r["title"]) + len(r["description"]) + sum(len(f["name"]) + len(f["value"]) for f in r.get("fields", []))
        self.assertLessEqual(size, 6000)
        self.assertEqual([e for e in self.run_feed(dt=sunday - self.now + 600) if "recap" in e["title"]], [])  # once


class Format(unittest.TestCase):
    def test_hours_and_durations(self):
        self.assertEqual((notify.fh(5400), notify.fh(36000 * 1.5)), ("1.5 h", "15 h"))
        self.assertEqual([notify.fdur(s) for s in (30, 600, 3600, 5400)], ["30 s", "10 min", "1h", "1h 30m"])

    def test_words(self):
        self.assertEqual((notify.pl(1, "death"), notify.pl(1234, "death")), ("1 death", "1,234 deaths"))
        self.assertEqual((notify.fpct(0.05), notify.fpct(0.5)), ("5.0 %", "50 %"))
        self.assertEqual(notify.and_list(["a", "b", "c"]), "a, b and c")
        self.assertEqual(notify.esc("*bold*"), "\\*bold\\*")  # Discord markdown, escaped


if __name__ == "__main__":
    unittest.main()
