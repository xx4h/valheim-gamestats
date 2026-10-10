"""The demo (demo/generate.py, published to GitHub Pages every day): it runs, it's deterministic, and the page gets a
whole server's worth of data from it — every player, bosses, the world, the map."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

import test_golden
from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import chunks

GENERATE = os.path.join(os.path.dirname(__file__), "..", "..", "demo", "generate.py")
END = 1_791_500_000  # a fixed end: the same history every time


def load_generator():
    spec = importlib.util.spec_from_file_location("demo_generate", GENERATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Demo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gen = load_generator()
        cls.dir = tempfile.mkdtemp()
        cls.out = os.path.join(cls.dir, "site")
        cls.sim = cls.gen.build(cls.out, seed=7, target=120, end=END)
        cls.data = test_golden.served(cls.out)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir)

    def test_a_static_site(self):
        for name in ("index.html", "app.js", "style.css", "index.json", "terrain.png", "explored.png"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)), name)
        index = read_json(os.path.join(self.out, "index.json"))
        self.assertTrue(all(os.path.exists(os.path.join(self.out, "c", n)) for n in index["files"]))

    def test_a_whole_server(self):
        d = self.data
        self.assertEqual(sorted({s["p"] for s in d["sessions"]}), sorted(p["p"] for p in self.gen.PLAYERS))
        self.assertAlmostEqual(d["day"], 120, delta=15)
        self.assertEqual(d["generated"], END)
        self.assertEqual(sorted(d["online"]), ["Astrid", "Bjorn"])
        self.assertTrue(d["deaths"] and d["raids"] and d["zones"] and d["gather"] and d["fights"] and d["visits"])
        self.assertIn("defeated_eikthyr", d["world"]["keys"])
        self.assertGreater(sum(v["total"] for v in d["world"]["pieces"].values()), 100)
        self.assertTrue(d["world"]["named_tames"] and d["world"]["signs"] and d["world"]["portals"])
        self.assertGreater(len(d["world_history"]), 1)
        self.assertEqual(d["scoring"]["changed"], {})
        # every prefab named: the manifest the collector reads changes with each save (its time is the save's)
        self.assertEqual([k for k in d["world"]["items"] if k.startswith("#")], [])

    def test_gear(self):
        # the equipment card and the gear history: every player's last seen gear and look, who wears it now
        eq = self.data["equipment"]
        self.assertEqual(sorted(eq), sorted(p["p"] for p in self.gen.PLAYERS))
        self.assertEqual(sorted(p for p, e in eq.items() if e["online"]), ["Astrid", "Bjorn"])
        for p, e in eq.items():
            self.assertTrue({"helmet", "chest", "legs"} <= set(e["slots"]), p)
            self.assertTrue({"right", "rightBack"} & set(e["slots"]), p)
            self.assertEqual(set(e["look"]), {"m", "skin", "hair", "h", "b"})
            self.assertLessEqual(e["t"], END)
        self.assertTrue(any(len(e["usage"]["helmet"]) > 1 for e in eq.values()))  # gear follows the stages

    def test_exploring_together_credits_only_who_was_there(self):
        # the demo keeps the rules it shows off: a zone is credited to players online at the time
        spans = [(s["p"], s["s"], s["e"] or END) for s in self.data["sessions"]]
        for z in self.data["zones"]:
            for p in z["by"]:
                self.assertTrue(any(q == p and a - 60 <= z["t"] <= b + 60 for q, a, b in spans), (p, z["t"]))

    def test_deterministic(self):
        again = os.path.join(self.dir, "again")
        self.gen.build(again, seed=7, target=120, end=END)
        a, b = (json.dumps(chunks.merge(*self.read(d)), sort_keys=True) for d in (self.out, again))
        self.assertEqual(a, b)

    def read(self, d):
        index = read_json(os.path.join(d, "index.json"))
        return index, {n: read_json(os.path.join(d, "c", n)) for n in index["files"]}


if __name__ == "__main__":
    unittest.main()
