"""Combat facts from a recorded trace (trace_import.py): which plugin run each server start in it belongs to, its clock on
the store's, and what of it becomes facts."""
import contextlib
import datetime
import io
import json
import os
import tempfile
import unittest

import logs  # noqa: F401 — first: puts collector/ (the package's directory) on the path

from valheim_gamestats import events, trace_import

DAY = datetime.date(2026, 3, 14)
BEGIN = datetime.datetime(2026, 3, 14, tzinfo=datetime.UTC).timestamp()
META = {"k": "meta", "noragdoll": ["Bonemass"], "drops": {"Bonemass": ["Wishbone"]}, "names": {"Bonemass": "Bonemass"}}


def server(length, meta=True, deaths=()):
    """One server start's trace: ticks from 30 s on, its prefabs' facts, players dying at the given clock times."""
    lines = [{"k": "tick", "t": 30.0, "ps": []}] + ([dict(META)] if meta else [])
    for t in range(31, int(length) + 1):
        lines.append({"k": "tick", "t": float(t), "ps": []})
        for p, at in deaths:
            if at == t:
                lines.append({"k": "player", "t": float(t), "p": p, "b": 20.0, "a": 0.0, "mb": 20.0, "ma": 0.0})
    return lines


class Facts(unittest.TestCase):
    def test_what_the_facts_keep(self):
        lines = [
            dict(META),
            {"k": "tick", "t": 40.0, "ps": []},
            {"k": "attack", "t": 41.0, "p": "Ragnar", "w": "AxeIron"},
            {"k": "trig", "t": 41.0, "m": "player:Ragnar", "tr": "swing_axe"},
            {"k": "trig", "t": 41.5, "m": "Skeleton_Friendly", "u": "5:1", "tamed": True, "fol": "Ragnar", "own": 7},
            {"k": "trig", "t": 41.6, "m": "Neck", "u": "5:2"},
            {"k": "hit", "t": 42.0, "m": "Bonemass", "u": "5:3", "own": 7, "am": "player:Ragnar", "from": "Ragnar"},
            {"k": "hit", "t": 42.1, "m": "player:Ragnar", "u": "7:9", "own": 7},
            {"k": "health", "t": 42.2, "m": "Bonemass", "u": "5:3", "b": 100, "a": 0, "l": [{"n": "Ragnar"}]},
            {"k": "player", "p": "Ragnar", "b": 20.0, "a": 19.0, "mb": 20.0, "ma": 19.0},
            {"k": "player", "t": 42.3, "p": "Ragnar", "b": 20.0, "a": 18.0, "mb": 21.0, "ma": 20.0},
            {"k": "killnote", "t": 42.4, "from": "Ragnar", "to": "Astrid", "m": "Bonemass"},
            {"k": "destroy", "t": 43.0, "m": "Bonemass", "u": "5:3", "from": "Ragnar", "own": 7, "l": [], "ps": []},
            {"k": "drop", "t": 43.1, "i": "Wishbone", "u": "7:20", "own": 7},
            {"k": "drop", "t": 43.2, "i": "Wood", "u": "7:21", "own": 7},
            {"k": "drop", "t": 43.3, "i": "Wishbone", "u": "9:22", "own": 9},
        ]
        got = trace_import.facts(lines)
        self.assertTrue(all(f["e"] == "cf" for f in got))
        kinds = [f["k"] for f in got]
        self.assertEqual(kinds[:4], ["meta0", "meta", "meta", "meta"])  # one part per kind of prefab fact
        self.assertEqual(kinds[4:], ["attack", "trig", "hit", "health", "player", "killnote", "destroy", "drop"])
        attack, = (f for f in got if f["k"] == "attack")
        self.assertEqual(attack["an"], "swing_axe")  # from the trigger that came with it
        health, = (f for f in got if f["k"] == "health")
        self.assertEqual((health["own"], health["l"][0]["c"]), (7, 7))  # owner and client from the deletion
        player, = (f for f in got if f["k"] == "player")
        self.assertEqual(player["t"], 42.3)  # the one that only lost food left out
        note, = (f for f in got if f["k"] == "killnote")
        self.assertEqual(note["fromid"], 7)
        drop, = (f for f in got if f["k"] == "drop")
        self.assertEqual(drop["u"], "7:20")  # loot, from a known client

    def test_older_cost_and_no_time(self):
        lines = [{"k": "meta", "cost": [{"w": "StaffSkeleton", "a": "cast", "f": 10, "p": 2}]},
                 {"k": "tick", "t": 50.0}, {"k": "player", "p": "Sigrid", "b": 20.0, "a": 10.0, "mb": 20.0, "ma": 20.0}]
        got = trace_import.facts(lines)
        self.assertEqual(got[1]["d"], {"StaffSkeleton/cast": {"f": 10, "p": 2}})
        self.assertEqual(got[2]["t"], 50.0)

    def test_big_prefab_facts_in_parts(self):
        meta = {"k": "meta", "names": {f"Creature{i}": "x" * 40 for i in range(200)}}
        parts = [f for f in trace_import.facts([meta]) if f["k"] == "meta"]
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(json.dumps(p["d"])) <= trace_import.PART + 100 for p in parts))
        self.assertEqual(sum(len(p["d"]) for p in parts), 200)


class Plan(unittest.TestCase):
    def test_server_starts_by_their_length(self):
        starts = [BEGIN - 3600, BEGIN + 3600, BEGIN + 3600 + 1000, BEGIN + 3600 + 1000 + 2200]
        lines = server(1000 - 31) + server(2200 - 31) + server(500)  # the file's first began at the day's start
        rows = trace_import.plan(lines, starts, [], DAY)
        self.assertEqual([r[0] for r in rows], starts[1:])
        self.assertEqual({round(r[1] - r[0], 1) for r in rows}, {trace_import.OFFSET})

    def test_the_run_before_the_day(self):
        starts = [BEGIN - 600, BEGIN + 3600]
        rows = trace_import.plan(server(4200 - 31) + server(300), starts, [], DAY)
        self.assertEqual([r[0] for r in rows], starts)

    def test_clock_by_the_deaths(self):
        start = BEGIN + 3600
        deaths = [("Astrid", start + 33.5 + 400), ("Bjorn", start + 33.5 + 900), ("Leif", start + 500)]
        rows = trace_import.plan(server(1000, deaths=[("Astrid", 400), ("Bjorn", 900)]), [start], deaths, DAY)
        self.assertAlmostEqual(rows[0][1] - start, 33.5)
        self.assertEqual(rows[0][2], "2 deaths")

    def test_without_deaths_the_others_offset(self):
        starts = [BEGIN + 100, BEGIN + 100 + 2000]
        deaths = [("Astrid", starts[1] + 32.0 + 600)]
        rows = trace_import.plan(server(2000 - 31) + server(1000, deaths=[("Astrid", 600)]), starts, deaths, DAY)
        self.assertAlmostEqual(rows[0][1] - starts[0], 32.0)
        self.assertIn("no death", rows[0][2])

    def test_refused_when_nothing_fits(self):
        with self.assertRaises(ValueError):
            trace_import.plan(server(100) + server(100), [BEGIN + 10], [], DAY)
        with self.assertRaises(ValueError):
            trace_import.plan(server(100) + server(100), [BEGIN + 10, BEGIN + 5000, BEGIN + 9000], [], DAY)


class Run(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.starts = [BEGIN + 100, BEGIN + 100 + 1000, BEGIN + 100 + 3000, BEGIN + 100 + 4000]
        db = events.open_db(self.dir.name)
        for i, s in enumerate(self.starts):
            events.add(db, "store", i, {"t": s, "e": "plugin"})
        events.add(db, "store", 10, {"t": self.starts[3] + 60, "e": "cf", "k": "meta0", "v": 2})  # stores its own
        db.commit()
        db.close()
        lines = (server(1000 - 31, meta=False) + server(2000 - 31) + server(1000 - 31) + server(300))
        lines.insert(len(server(1000 - 31, meta=False)) + 10, {"k": "attack", "t": 39.0, "p": "Ragnar", "w": "Club"})
        self.path = os.path.join(self.dir.name, "2026-03-14.jsonl")
        with open(self.path, "w") as f:
            f.writelines(json.dumps(x) + "\n" for x in lines)

    def run_import(self, write):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            n = trace_import.run(self.dir.name, self.path, write=write)
        return n, out.getvalue()

    def cf(self):
        db = events.open_db(self.dir.name)
        try:
            return [ev for ev in events.load(db) if ev.get("e") == "cf"]
        finally:
            db.close()

    def test_dry_run_writes_nothing(self):
        n, out = self.run_import(False)
        self.assertEqual(n, 0)
        self.assertEqual(len(self.cf()), 1)
        self.assertIn("no prefab facts", out)
        self.assertIn("has facts in the store already", out)

    def test_the_runs_without_facts_once(self):
        n, out = self.run_import(True)
        got = [ev for ev in self.cf() if ev["t"] < self.starts[3]]
        self.assertEqual(n, len(got))
        self.assertEqual({ev["k"] for ev in got}, {"meta0", "meta", "attack"})
        attack, = (ev for ev in got if ev["k"] == "attack")
        self.assertAlmostEqual(attack["t"], self.starts[1] + trace_import.OFFSET + 39.0)
        self.assertTrue(all(self.starts[1] <= ev["t"] < self.starts[3] for ev in got))
        self.assertEqual(self.run_import(True)[0], 0)


if __name__ == "__main__":
    unittest.main()
