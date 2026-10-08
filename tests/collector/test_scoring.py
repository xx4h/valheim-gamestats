"""What counts how much (scoring.py, scoring.json, docs/SCORING.md): the defaults are the only copy of the numbers, a
server's overrides merge in and are checked, the page and the Discord feed compute from what the data carries — and a
changed rule is never news."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import test_golden
import test_notify
from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import notify, scoring

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
PACKAGE_DIR = os.path.join(ROOT, "collector")


def read(*path):
    with open(os.path.join(ROOT, *path), encoding="utf-8") as f:
        return f.read()


class Defaults(unittest.TestCase):
    def test_valid_and_unchanged(self):
        rules, changed = scoring.merge()
        self.assertEqual(changed, {})
        self.assertEqual(rules, scoring.defaults())
        self.assertEqual(len(rules["titles"]), 86)

    def test_the_only_copy_of_the_numbers(self):
        # the tables that used to live in the page and the feed — and drifted apart — are gone from both
        app, feed = read("site", "app.js"), read("collector", "valheim_gamestats", "notify.py")
        for name in ("IMPACT_W", "IMPACT_PENALTY", "CARD_AT", "CARD_DPH", "BADGE_TIERS", "MILESTONE_STEPS", "GRADE_MIN_H",
                     "AWARD_GROUPS"):
            self.assertNotRegex(app, rf"const {name} = [\[{{\d]", name)  # a table or number of its own
        self.assertNotRegex(app, r"const (BADGES|TRAITS|SUBJECTS) = \[", "badges, traits, grades")
        self.assertNotRegex(app, r"\{ k: 'marathon', g: 'time'", "title definitions")
        for name in ("AWARDS", "CARD_AT", "CARD_DPH", "PLAYER_HOURS", "GROUPS", "LOW", "PAIRS"):
            self.assertNotRegex(feed, rf"(?m)^{name} = ", name)

    def test_every_title_reads_on_the_page_and_in_the_feed(self):
        titles = set(scoring.defaults()["titles"])
        app = read("site", "app.js")
        block = app[app.index("const TITLE_FMT = {"):]
        block = block[:block.index("\n  };")]
        self.assertEqual(set(re.findall(r"(?m)^    (\w+): ", block)) | RAIDS_ON_PAGE, titles)
        self.assertLessEqual(set(notify.FMT), titles)
        # the feed leaves out only the combat & gathering titles: the page computes them from per-player breakdowns
        self.assertEqual({k for k, t in scoring.defaults()["titles"].items() if k not in notify.FMT},
                         {k for k, t in scoring.defaults()["titles"].items() if t["group"] == "fight"})


RAIDS_ON_PAGE = {f"raid_{n}" for n in notify.RAID_TITLES}  # one formatter for all of them, in a loop


class Merge(unittest.TestCase):
    def test_server_wins_over_global(self):
        rules, changed = scoring.merge({"impact": {"bonus": {"built": 30, "play": 10}}}, {"impact": {"bonus": {"built": 40}}})
        self.assertEqual((rules["impact"]["bonus"]["built"], rules["impact"]["bonus"]["play"]), (40, 10))
        self.assertEqual(changed, {"impact.bonus.built": 18, "impact.bonus.play": 22})

    def test_switch_off(self):
        rules, changed = scoring.merge({"titles": {"ragequit": {"enabled": False}}, "badges": {"forager": {"enabled": False}},
                                        "traits": {"honey": {"enabled": False}}, "medals": {"deaths": {"enabled": False}},
                                        "grades": {"subjects": {"punctuality": {"enabled": False}}}})
        self.assertNotIn("ragequit", rules["titles"])
        self.assertNotIn("forager", rules["badges"])
        self.assertNotIn("honey", rules["traits"])
        self.assertNotIn("deaths", rules["medals"])
        self.assertNotIn("punctuality", rules["grades"]["subjects"])
        self.assertIn("titles.ragequit.enabled", changed)
        # switched on again by the server: as if never off
        rules, changed = scoring.merge({"titles": {"ragequit": {"enabled": False}}}, {"titles": {"ragequit": {"enabled": True}}})
        self.assertIn("ragequit", rules["titles"])
        self.assertEqual(changed, {})

    def test_numbers_lists_and_texts(self):
        rules, changed = scoring.merge({"titles": {"marathon": {"min": 7200, "title": "Iron seat"}},
                                        "badges": {"slayer": {"steps": [5, 50, 500, 5000, 50000]}},
                                        "badge_tiers": [{"name": "Wood"}, {}, {}, {}, {"icon": "👑"}],
                                        "milestones": {"zones": [100, 200], "day_every": 100},
                                        "cards": {"tiers": {"legendary": 90}}})
        self.assertEqual(rules["titles"]["marathon"]["min"], 7200)
        self.assertEqual(rules["titles"]["marathon"]["title"], "Iron seat")
        self.assertEqual(rules["badges"]["slayer"]["steps"][0], 5)
        self.assertEqual([t["name"] for t in rules["badge_tiers"]][:2], ["Wood", "Silver"])
        self.assertEqual(rules["badge_tiers"][4]["icon"], "👑")
        self.assertEqual(rules["milestones"]["zones"], [100, 200])
        self.assertEqual(changed["titles.marathon.min"], 60)
        self.assertEqual(changed["milestones.zones"][0], 500)

    def test_every_mistake_named_at_once(self):
        bad = {"impact": {"bonus": {"built": -1, "nope": 3}}, "titles": {"marathon": {"low": True, "min": "1h"},
               "ragequit": {"enabled": "no"}, "unknown": {"min": 1}, "streak": {"group": "fun"}}}
        with self.assertRaises(ValueError) as e:
            scoring.merge(bad)
        msg = str(e.exception)
        for part in ("impact.bonus.built: expected a number ≥ 0", "impact.bonus.nope: unknown", "titles.marathon.low: fixed",
                     "titles.marathon.min: expected a number", "titles.ragequit.enabled: expected true or false",
                     "titles.unknown: unknown"):
            self.assertIn(part, msg)

    def test_what_types_dont_say(self):
        cases = [
            ({"titles": {"streak": {"group": "fun"}}}, "titles.streak.group: 'fun' isn't a group"),
            ({"badges": {"slayer": {"steps": [1, 2, 3]}}}, "badges.slayer.steps: 5 numbers"),
            ({"badges": {"slayer": {"steps": [5, 4, 3, 2, 1]}}}, "badges.slayer.steps: 5 numbers"),
            ({"grades": {"subjects": {"survival": {"steps": [2.5, 1.2, 0.6, 0.3, 0.15]}}}}, "each bigger"),
            ({"grades": {"subjects": {"attendance": {"steps": [0.2, 0.35, 0.55, 0.75, 0.9]}}}}, "each smaller"),
            ({"milestones": {"zones": [500, 100]}}, "milestones.zones"),
            ({"cards": {"tiers": {"rare": 60}}}, "cards.tiers"),
            ({"cards": {"at": {"built": 0}}}, "cards.at.built"),
            ({"impact": {"bonus": dict.fromkeys(scoring.defaults()["impact"]["bonus"], 0)}}, "impact.bonus: at least one"),
            ({"badge_tiers": [{"name": "Wood"}]}, "badge_tiers: expected a list of 5"),
            ({"titles": "off"}, "titles: expected a mapping"),
            ({"titles": {"marathon": {"title": " "}}}, "titles.marathon.title: expected a text"),
        ]
        for override, want in cases:
            with self.subTest(want=want), self.assertRaisesRegex(ValueError, re.escape(want)):
                scoring.merge(override)

    def test_digest(self):
        a = scoring.merge()[0]
        b = scoring.merge({"titles": {"marathon": {"min": 1}}})[0]
        self.assertEqual(scoring.digest(a, "titles"), scoring.digest(scoring.merge()[0], "titles"))
        self.assertNotEqual(scoring.digest(a, "titles"), scoring.digest(b, "titles"))
        self.assertEqual(scoring.digest(a, "cards"), scoring.digest(b, "cards"))


class Publish(unittest.TestCase):
    def test_in_the_data(self):
        # config.json "scoring" for all servers, servers[].scoring for one; the data carries the result and what changed
        over = {"scoring": {"titles": {"ragequit": {"enabled": False}}, "impact": {"bonus": {"built": 30}}}}
        with mock.patch.dict(test_golden.CFG, {"scoring": {"impact": {"bonus": {"built": 25, "dist": 5}}}}), \
                mock.patch.dict(test_golden.SERVER, over):
            data, _, d = test_golden.build(test_golden.Log().at(test_golden.DAY + 3 * test_golden.HOUR))
        shutil.rmtree(d)
        sc = data["scoring"]
        self.assertNotIn("ragequit", sc["rules"]["titles"])
        self.assertEqual((sc["rules"]["impact"]["bonus"]["built"], sc["rules"]["impact"]["bonus"]["dist"]), (30, 5))
        self.assertEqual(sc["changed"], {"impact.bonus.built": 18, "impact.bonus.dist": 0, "titles.ragequit.enabled": True})

    def test_names_the_server(self):
        with self.assertRaisesRegex(ValueError, r"^\[mine\] scoring: titles\.x: unknown"):
            scoring.publish({}, {"id": "mine", "scoring": {"titles": {"x": {}}}})


class Command(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.config = os.path.join(self.dir, "config.json")
        self.env = {**os.environ, "PYTHONPATH": PACKAGE_DIR, "CONFIG": self.config, "DATA_DIR": self.dir}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_cmd(self, *args, module="valheim_gamestats.scoring"):
        return subprocess.run([sys.executable, "-m", module, *args], env=self.env, capture_output=True, text=True, timeout=60)

    def write(self, cfg):
        with open(self.config, "w") as f:
            json.dump(cfg, f)

    def test_check_and_show(self):
        self.write({"servers": [{"id": "a", "scoring": {"titles": {"marathon": {"min": 120}}}}, {"id": "b"}]})
        r = self.run_cmd("check", self.config)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["a: ok, 1 changed: titles.marathon.min", "b: ok, 0 changed"])
        r = self.run_cmd("show", self.config, "a")
        self.assertEqual(json.loads(r.stdout)["a"]["rules"]["titles"]["marathon"]["min"], 120)

    def test_check_names_the_mistake(self):
        self.write({"servers": [{"id": "a", "scoring": {"impact": {"bonus": {"bilt": 30}}}}]})
        r = self.run_cmd("check", self.config)
        self.assertEqual(r.returncode, 1)
        self.assertIn("[a] scoring: impact.bonus.bilt: unknown — one of play, nDays", r.stderr)

    def test_usage(self):
        r = self.run_cmd()
        self.assertEqual(r.returncode, 2)
        self.assertIn("python3 -m valheim_gamestats.scoring check config.json", r.stderr)

    def test_the_collector_wont_start_with_a_mistake(self):
        self.write({"servers": [{"id": "a", "rcon": {"host": "127.0.0.1", "port": 9}, "scoring": {"titles": {"x": {}}}}]})
        r = self.run_cmd("--once", module="valheim_gamestats")
        self.assertEqual(r.returncode, 2)
        self.assertIn("config: [a] scoring: titles.x: unknown", r.stdout)

    def test_chart_schema_is_current(self):
        # Helm checks the values against it: a typo fails the install, not the collector (regenerate with `schema`)
        self.assertEqual(json.loads(read("chart", "valheim-gamestats", "values.schema.json")), scoring.schema())
        self.assertEqual(json.loads(self.run_cmd("schema").stdout), scoring.schema())


class Schema(unittest.TestCase):
    """The schema says what merge() says about types: a simple validator over the subset of JSON Schema it uses."""

    def valid(self, schema, v):
        t = schema.get("type")
        if t == "object":
            return isinstance(v, dict) and all(k in schema["properties"] and self.valid(schema["properties"][k], x)
                                               for k, x in v.items())
        if t == "array":
            return (isinstance(v, list) and schema.get("minItems", 0) <= len(v) <= schema.get("maxItems", len(v))
                    and all(self.valid(schema["items"], x) for x in v))
        if t == "number":
            return isinstance(v, int | float) and not isinstance(v, bool) and v >= schema["minimum"]
        if t == "boolean":
            return isinstance(v, bool)
        return isinstance(v, str) and len(v) >= schema["minLength"]

    def test_agrees_with_merge(self):
        s = scoring.schema()["definitions"]["scoring"]
        good = [{"titles": {"ragequit": {"enabled": False}, "marathon": {"min": 7200}}}, {"badge_tiers": [{}, {}, {}, {}, {}]},
                {"grades": {"subjects": {"survival": {"enabled": False}}}}, {"milestones": {"day_every": 0}}]
        bad = [{"titles": {"marathon": {"low": True}}}, {"titles": {"x": {}}}, {"impact": {"bonus": {"built": -1}}},
               {"titles": {"ragequit": {"enabled": "no"}}}, {"badge_tiers": [{}]}, {"cards": {"tiers": {"rare": "x"}}}]
        for o in good:
            self.assertTrue(self.valid(s, o), o)
            scoring.merge(o)
        for o in bad:
            self.assertFalse(self.valid(s, o), o)
            self.assertRaises(ValueError, scoring.merge, o)


class Feed(unittest.TestCase):
    """The Discord feed under a server's own rules."""

    setUp, tearDown, post, run_feed = (test_notify.Feed.setUp, test_notify.Feed.tearDown, test_notify.Feed.post,
                                       test_notify.Feed.run_feed)

    def with_rules(self, override):
        data = json.loads(json.dumps(self.data))
        data["scoring"] = scoring.publish({"scoring": override}, {})
        return data

    def test_a_switched_off_title_is_not_computed(self):
        c = notify.Ctx(self.with_rules({"titles": {"marathon": {"enabled": False}}}), "")
        P, _ = notify.stats(c, 0, c.now + 1)
        self.assertIn("marathon", notify.award_table(P, notify.Ctx(self.data, "").rules))
        self.assertNotIn("marathon", notify.award_table(P, c.rules))

    def test_a_minimum_nobody_reaches(self):
        c = notify.Ctx(self.with_rules({"titles": {"marathon": {"min": 10 ** 9}}}), "")
        P, _ = notify.stats(c, 0, c.now + 1)
        self.assertNotIn("marathon", notify.award_table(P, c.rules))

    def test_medal_columns(self):
        c = notify.Ctx(self.with_rules({"medals": {"deaths": {"enabled": False}}}), "")
        P, _ = notify.stats(c, 0, c.now + 1)
        self.assertNotIn("deaths", notify.medal_table(P, c.rules))
        self.assertIn("play", notify.medal_table(P, c.rules))

    def test_card_tiers_follow_the_rules(self):
        easy = self.with_rules({"cards": {"at": dict.fromkeys(scoring.defaults()["cards"]["at"], 1), "dph": 100,
                                          "tiers": {"rare": 1, "epic": 2, "legendary": 3}}})
        c = notify.Ctx(easy, "")
        P, _ = notify.stats(c, 0, c.now + 1)
        tiers = notify.card_tiers(c, P, easy.get("world"))
        self.assertTrue(tiers)
        self.assertEqual({t for t, _ in tiers.values()}, {"legendary"})

    def test_milestone_steps(self):
        data = self.with_rules({"milestones": {"zones": [1, 2], "day_every": 0}})
        ids = [e[0] for e in notify.events(notify.Ctx(data, ""))[0]]
        self.assertIn("ms:zones:2", ids)
        self.assertFalse([i for i in ids if i.startswith("ms:day:")])

    def test_a_changed_rule_is_not_news(self):
        self.run_feed()
        path = os.path.join(self.sdir, "notify.json")
        before = read_json(path)
        self.assertEqual(before["card_scale"], notify.CARD_SCALE)  # default rules: the marks from before they were rules
        # every kind of change at once: titles change hands, medal columns, card tiers, new milestone steps passed long ago
        changed = self.with_rules({"titles": {"marathon": {"min": 10 ** 9}, "streak": {"enabled": False}},
                                   "medals": {"play": {"enabled": False}},
                                   "cards": {"tiers": {"rare": 1, "epic": 2, "legendary": 3}},
                                   "milestones": {"zones": [1, 2], "player_hours": [1]}})
        for dt in (60, 60 + notify.DEBOUNCE, 120 + 2 * notify.DEBOUNCE):
            self.assertEqual(self.run_feed(changed, dt=dt), [], dt)
        after = read_json(path)
        self.assertNotEqual(after["award_defs"], before["award_defs"])
        self.assertTrue(str(after["card_scale"]).startswith(f"{notify.CARD_SCALE}:"))
        self.assertNotIn("award:marathon", after["standings"])
        self.assertNotIn("medal:play", after["standings"])
        self.assertIn("ms:zones:2", after["seen"])
        # back to the defaults: learnt again, silently
        self.assertEqual(self.run_feed(dt=180 + 3 * notify.DEBOUNCE), [])
        self.assertEqual(read_json(path)["card_scale"], notify.CARD_SCALE)

    def test_title_texts_come_from_the_rules(self):
        self.run_feed()
        path = os.path.join(self.sdir, "notify.json")
        state = read_json(path)
        key = next(k for k in state["standings"] if k.startswith("award:"))
        k = key.split(":", 1)[1]
        renamed = self.with_rules({"titles": {k: {"title": "Renamed", "icon": "🦄", "rule": "Most things ({tz})"}}})
        self.run_feed(renamed, dt=60)  # a new text is a new rule: learnt silently
        state = read_json(path)
        state["standings"][key] = [["Nobody"], 1]
        with open(path, "w") as f:
            json.dump(state, f)
        self.run_feed(renamed, dt=120)
        posted = self.run_feed(renamed, dt=120 + notify.DEBOUNCE)
        self.assertEqual([e["title"] for e in posted], ["🦄 Renamed title"])
        self.assertIn("*Most things (Europe/Berlin)*", posted[0]["description"])



if __name__ == "__main__":
    unittest.main()
