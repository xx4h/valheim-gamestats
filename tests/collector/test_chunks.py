"""data.json in pieces (chunks.py): joined back it's exactly the data, the history lands where an open page needs it,
and only what changed gets a new name."""
import calendar
import json
import os
import shutil
import tempfile
import time
import unittest

from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import chunks, scoring

GOLDEN = read_json(os.path.join(os.path.dirname(__file__), "golden", "data.json"))
SITE = read_json(os.path.join(os.path.dirname(__file__), "..", "site", "fixture", "data.json"))
DAY = 86400


def parsed(files):
    return {n: json.loads(raw) for n, raw in files.items()}


def at(s):
    return calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M"))  # UTC


class Split(unittest.TestCase):
    def roundtrip(self, data, now=None):
        index, files = chunks.split(data, now)
        self.assertEqual(chunks.merge(index, parsed(files)), json.loads(json.dumps(data)))
        return index, files

    def test_golden_roundtrip(self):
        self.roundtrip(GOLDEN)

    def test_real_data_roundtrip(self):
        # 11 days of a real server, at its own time and a month later (months, weeks and days all in use)
        index, _ = self.roundtrip(SITE)
        later, _ = self.roundtrip(SITE, SITE["generated"] + 40 * DAY)
        self.assertTrue(any(n.startswith("m") for n in later["files"]))

    def test_rules_keep_their_order(self):
        # the page lists title groups and titles in the order of scoring.json, not alphabetically
        index, files = chunks.split({**GOLDEN, "scoring": scoring.publish({}, {})})
        rules = chunks.merge(index, parsed(files))["scoring"]["rules"]
        self.assertEqual(list(rules["title_groups"]), list(scoring.defaults()["title_groups"]))
        self.assertEqual(list(rules["titles"])[:2], ["marathon", "streak"])

    def test_empty_lists_stay(self):
        # a fresh server: no deaths, no raids yet — still lists for the page, not missing keys
        data = {**GOLDEN, "deaths": [], "raids": []}
        index, files = self.roundtrip(data)
        self.assertEqual(chunks.merge(index, parsed(files))["deaths"], [])

    def test_buckets(self):
        now = at("2026-10-07 18:00")  # a Wednesday
        self.assertEqual(chunks.bucket(at("2026-10-07 00:00"), now), ("live", ""))
        self.assertEqual(chunks.bucket(at("2026-10-06 23:59"), now), ("d", "2026-10-06"))
        self.assertEqual(chunks.bucket(at("2026-10-05 00:00"), now), ("d", "2026-10-05"))  # Monday: this week
        self.assertEqual(chunks.bucket(at("2026-10-04 23:59"), now), ("w", "2026-09-28"))
        self.assertEqual(chunks.bucket(at("2026-09-07 00:00"), now), ("w", "2026-09-07"))  # 4 weeks back
        self.assertEqual(chunks.bucket(at("2026-09-06 23:59"), now), ("m", "2026-09"))

    def test_open_ones_ride_in_live(self):
        index, files = chunks.split(SITE, SITE["generated"] + 3 * DAY)
        live = json.loads(files[index["files"][-1]])
        self.assertTrue(index["files"][-1].startswith("live-"))
        self.assertTrue(all(s["e"] is None for s in live.get("sessions", [])))  # days later: only what's still open
        self.assertIn("positions", live)
        self.assertNotIn("world", live)  # the hourly part has its own file

    def test_only_what_changed_gets_a_new_name(self):
        now = SITE["generated"]
        a, _ = chunks.split(SITE, now)
        b, _ = chunks.split({**SITE, "generated": now + 60, "online": ["x"]}, now + 60)
        changed = set(a["files"]) ^ set(b["files"])
        self.assertEqual(sorted(n.split("-")[0] for n in changed), ["live", "live"])
        late = json.loads(json.dumps(SITE))
        late["deaths"].insert(0, {"p": "Ragnar", "t": SITE["first"] + 60})  # caught up on an old one
        c, _ = chunks.split(late, now)
        self.assertEqual(len(set(a["files"]) ^ set(c["files"])), 2)  # that old file, under a new name

    def test_parts_with_their_own_clock(self):
        # a gear move (custody) or a Steam check changes only that part's file, not the world's or the pets'
        a, _ = chunks.split(SITE)
        moved = json.loads(json.dumps(SITE))
        moved["custody"][0][3].append([SITE["generated"], "Ragnar", "take", "chest", 0, 0, 1])
        b, _ = chunks.split(moved)
        self.assertEqual(sorted(n.split("-")[0] for n in set(a["files"]) ^ set(b["files"])), ["custody", "custody"])
        self.assertEqual({n.split("-")[0] for n in a["files"]} & {"world", "pets", "steam", "state"},
                         {"world", "pets", "steam", "state"})

    def test_small(self):
        # what an open page fetches every minute: the index and live
        index, files = chunks.split(SITE)
        self.assertLess(len(json.dumps(index)), 2048)
        self.assertLess(len(files[index["files"][-1]]), len(json.dumps(SITE)) / 5)


class Write(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_write_and_clean_up(self):
        chunks.write(self.dir, SITE)
        old = set(os.listdir(os.path.join(self.dir, "c")))
        index = chunks.write(self.dir, {**SITE, "generated": SITE["generated"] + 60, "online": []})
        files = set(os.listdir(os.path.join(self.dir, "c")))
        self.assertEqual(read_json(os.path.join(self.dir, "index.json")), index)
        self.assertTrue(old - set(index["files"]) <= files)  # left behind, but kept for an hour
        for n in old - set(index["files"]):
            os.utime(os.path.join(self.dir, "c", n), (0, 0))
        chunks.write(self.dir, {**SITE, "generated": SITE["generated"] + 60, "online": []})
        self.assertEqual(set(os.listdir(os.path.join(self.dir, "c"))), set(index["files"]))


if __name__ == "__main__":
    unittest.main()
