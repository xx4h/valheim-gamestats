"""The collector's combat rules (combat.py) on recorded fights (tests/combat/, made with tools/combat_fixture.py):
the same sums as the plugin's rules (tests/plugin checks CombatCore against the same expected files)."""
import glob
import gzip
import json
import os
import unittest

import logs  # noqa: F401 — first: puts collector/ (the package's directory) on the path

from valheim_gamestats import combat

HERE = os.path.join(os.path.dirname(__file__), "..", "combat")
COUNTS = {"kill", "wkill", "kw", "skw", "ukill", "hit"}


def facts(path):
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def run(path):
    sums = {}

    def out(t, e, p, i, n):
        if e in combat.COLLECTOR_ONLY:
            return  # the plugin's rules never made these: nothing to compare
        key = f"{e}|{p}|{i}"
        sums[key] = sums.get(key, 0) + n
    feeder = combat.Feeder(out)
    last = 0.0
    for f in facts(path):
        if "t" in f:
            last = float(f["t"])
        feeder.feed(last, f)
    feeder.end(last)
    return sums


def same(key, a, b):
    if key.split("|")[0] in COUNTS:
        return abs(a - b) < 1e-9
    return abs(a - b) <= 0.05 + 1e-3 * max(abs(a), abs(b))


class Parity(unittest.TestCase):
    def test_recorded_fights_give_the_plugins_sums(self):
        fixtures = sorted(glob.glob(os.path.join(HERE, "*.jsonl.gz")))
        self.assertGreaterEqual(len(fixtures), 2)
        for path in fixtures:
            with self.subTest(fixture=os.path.basename(path)):
                with open(path.replace(".jsonl.gz", ".expected.json")) as f:
                    want = json.load(f)
                got = run(path)
                off = sorted(k for k in set(want) | set(got) if not same(k, want.get(k, 0), got.get(k, 0)))
                lines = [f"{k}: expected {want.get(k, 0):.4f}, got {got.get(k, 0):.4f}" for k in off[:10]]
                self.assertEqual(off, [], "\n".join(lines))


if __name__ == "__main__":
    unittest.main()


def run_events(path, start, version="1.22.0"):
    """A plugin run as the collector loads it: its start, then its facts at start + their own time."""
    evs = [{"t": start, "e": "plugin", "p": "", "i": version, "n": 1}]
    for f in facts(path):
        if "t" in f:
            evs.append(dict(f, t=start + 1 + float(f["t"])))
        else:
            evs.append(dict(f, t=start + 0.5))
    return evs


class Effective(unittest.TestCase):
    """Effective damage (edmg): what the hits would have done without the game scaling a creature's damage taken down
    by the players near it (1/(1+0.3(n-1)), n at most 5) — from the health facts' n, only where it was recorded."""

    def run_facts(self, facts):
        sums = {}

        def out(t, e, p, i, n):
            sums[(e, p, i)] = sums.get((e, p, i), 0) + n
        feeder = combat.Feeder(out)
        for t, f in facts:
            feeder.feed(t, f)
        feeder.end(facts[-1][0])
        return sums

    def fight(self, near):
        here = [{"n": "Ragnar", "b": True, "d": False, "x": 0, "y": 0, "z": 0, "h": "SwordIron", "c": 1001},
                {"n": "Astrid", "b": True, "d": False, "x": 2, "y": 0, "z": 0, "h": "SwordIron", "c": 1002}]
        health = {"k": "health", "u": "1:5", "m": "Troll", "x": 1, "y": 0, "z": 0, "l": here, "own": 1001}
        if near is not None:
            health["n"] = near
        return [(10.0, {"k": "meta0"}),
                (10.1, {"k": "attack", "p": "Ragnar", "w": "SwordIron", "an": "swing"}),
                (10.2, {"k": "attack", "p": "Astrid", "w": "SwordIron", "an": "swing"}),
                (10.5, dict(health, b=600, a=500)),
                (11.5, dict(health, b=500, a=0)),
                (11.6, {"k": "destroy", "u": "1:5", "m": "Troll", "x": 1, "y": 0, "z": 0, "h": 0, "mh": 600, "l": here,
                        "ps": here, "own": 1001})]

    @staticmethod
    def total(got, e):
        return sum(v for k, v in got.items() if k[0] == e)

    def test_scaled_by_the_players_near(self):
        self.assertEqual([combat.scale(n) for n in (None, 0, 1, 2, 3, 5, 8)], [None, None, 1.0, 1.3, 1.6, 2.2, 2.2])
        got = self.run_facts(self.fight(2))
        self.assertAlmostEqual(self.total(got, "dmg"), 600)
        self.assertAlmostEqual(self.total(got, "edmg"), 600 * 1.3)
        for (e, p, i), n in got.items():  # every player's share, scaled alike
            if e == "dmg":
                self.assertAlmostEqual(got[("edmg", p, i)], n * 1.3)

    def test_none_without_the_count(self):
        got = self.run_facts(self.fight(None))
        self.assertAlmostEqual(self.total(got, "dmg"), 600)
        self.assertEqual(self.total(got, "edmg"), 0)

    def test_what_was_left_at_death_as_the_last_drop(self):
        fight = self.fight(3)
        facts = fight[:-2] + [(11.6, {"k": "killnote", "from": "Ragnar", "fromid": 1001, "to": "Ragnar", "kind": "$enemy_troll"}),
                              (11.6, dict(fight[-1][1], h=200))]  # deleted with 200 left (its owner saw it die)
        got = self.run_facts(facts)
        self.assertAlmostEqual(self.total(got, "dmg"), 300)
        self.assertAlmostEqual(self.total(got, "edmg"), 300 * 1.6)


class Recompute(unittest.TestCase):
    FIXTURE = os.path.join(HERE, "afternoon.jsonl.gz")

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp()
        self.cache = os.path.join(self.dir, "combat.json")
        run = run_events(self.FIXTURE, 10_000)
        end = run[-1]["t"]
        self.evs = sorted(
            [{"t": 9_000, "e": "dmg", "p": "Ragnar", "i": "Troll", "n": 50}]           # before: an older run, no facts
            + run
            + [{"t": 10_100, "e": "dmg", "p": "Ragnar", "i": "Bonemass", "n": 999},    # the plugin's own result: replaced
               {"t": 10_200, "e": "kill", "p": "Ragnar", "i": "Bonemass", "n": 1},    # added by hand: replaced as well
               {"t": 10_300, "e": "pick", "p": "Ragnar", "i": "Stone", "n": 3},       # not combat: stays
               {"t": end + 100, "e": "plugin", "p": "", "i": "1.21.0", "n": 1},       # a later run without facts
               {"t": end + 200, "e": "dmg", "p": "Astrid", "i": "Neck", "n": 7}],
            key=lambda ev: ev["t"])
        self.end = end

    def test_results_from_facts_replace_the_plugins_in_that_run_only(self):
        out = combat.recompute(self.evs, self.cache)
        inside = [ev for ev in out if 10_000 <= ev["t"] < self.end + 100 and ev["e"] in combat.RESULTS]
        self.assertNotIn(999, [ev["n"] for ev in inside])
        kills = sorted((ev["p"], ev["i"]) for ev in inside if ev["e"] == "kill" and ev["i"] == "Bonemass")
        self.assertEqual(kills, [("Astrid", "Bonemass"), ("Astrid", "Bonemass"), ("Bjorn", "Bonemass"), ("Bjorn", "Bonemass"),
                                 ("Ragnar", "Bonemass"), ("Ragnar", "Bonemass")])
        self.assertIn({"t": 9_000, "e": "dmg", "p": "Ragnar", "i": "Troll", "n": 50}, out)
        self.assertIn({"t": self.end + 200, "e": "dmg", "p": "Astrid", "i": "Neck", "n": 7}, out)
        self.assertIn({"t": 10_300, "e": "pick", "p": "Ragnar", "i": "Stone", "n": 3}, out)
        self.assertEqual([ev["t"] for ev in out], sorted(ev["t"] for ev in out))

    def test_per_minute_and_rounded_like_the_plugin(self):
        out = combat.recompute(self.evs, None)
        res = [ev for ev in out if ev["e"] in combat.RESULTS and 10_000 <= ev["t"] < self.end + 100]
        self.assertTrue(all(isinstance(ev["n"], int) and ev["n"] >= 1 and ev["t"] % 60 == 59 for ev in res))
        with open(self.FIXTURE.replace(".jsonl.gz", ".expected.json")) as f:
            want = json.load(f)
        kills = sum(ev["n"] for ev in res if ev["e"] == "kill")
        self.assertEqual(kills, sum(v for k, v in want.items() if k.startswith("kill|")))

    def test_a_run_is_computed_again_only_when_its_facts_changed(self):
        combat.recompute(self.evs, self.cache)
        with open(self.cache) as f:
            self.assertEqual(json.load(f)["rules"], combat.RULES)
        real = combat._run
        try:
            combat._run = lambda facts: (_ for _ in ()).throw(AssertionError("recomputed"))
            out = combat.recompute(self.evs, self.cache)  # the same facts: from the cache
            self.assertTrue(any(ev["e"] == "kill" for ev in out))
            more = self.evs + [{"t": self.end + 50, "e": "cf", "k": "attack", "p": "Ragnar", "w": "SwordIron", "an": "swing"}]
            with self.assertRaises(AssertionError):  # a new fact in the run: computed again
                combat.recompute(sorted(more, key=lambda ev: ev["t"]), self.cache)
        finally:
            combat._run = real

    def test_a_rules_change_recomputes(self):
        combat.recompute(self.evs, self.cache)
        with open(self.cache) as f:
            data = json.load(f)
        data["rules"] = combat.RULES - 1
        with open(self.cache, "w") as f:
            json.dump(data, f)
        calls = []
        real = combat._run
        try:
            combat._run = lambda facts: calls.append(1) or real(facts)
            combat.recompute(self.evs, self.cache)
        finally:
            combat._run = real
        self.assertEqual(calls, [1])

    def test_no_facts_no_change(self):
        evs = [ev for ev in self.evs if ev["e"] != "cf"]
        self.assertEqual(combat.recompute(evs, self.cache), evs)
