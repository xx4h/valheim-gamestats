"""Boss fights (fights.py): who took part, damage, kills, deaths."""
import unittest

from logs import Log  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import fights

BOSSES = {"Eikthyr": {"boss": True}, "Troll": {}}


def build(log, now):
    deaths = [{"p": line.split(" from ")[1].split(" : ")[0], "t": ts / 1e9} for ts, line in log.rows if line.endswith(": 0:0")]
    return fights.build(log.events(), deaths, BOSSES, log.at(now))


class Fights(unittest.TestCase):
    def fight(self):
        log = Log().plugin(0, "1.15.0")
        log.g(60, e="dmg", p="Ragnar", i="Eikthyr", n=300).g(60, e="dw", p="Ragnar", i="AxeFlint>Eikthyr", n=300)
        log.g(60, e="dmg", p="Astrid", i="Eikthyr", n=200).g(60, e="dw", p="Astrid", i="Bow>Eikthyr", n=200)
        log.g(60, e="taken", p="Astrid", i="", n=50)
        log.death(90, "Astrid")
        log.g(120, e="dmg", p="Ragnar", i="Eikthyr", n=100).g(120, e="kill", p="Ragnar", i="Eikthyr", n=1)
        log.g(120, e="dmg", p="Bjorn", i="Troll", n=500)  # not a boss
        return log

    def test_fight_damage_per_player(self):
        f, = build(self.fight(), 600)
        self.assertEqual((f["boss"], f["outcome"], f["dmg"], f["exact"]), ("Eikthyr", "killed", 600, True))
        self.assertEqual({p: (v["d"], v["k"]) for p, v in f["players"].items()}, {"Ragnar": (400, 1), "Astrid": (200, 0)})
        self.assertEqual(f["players"]["Astrid"]["w"], {"Bow": 200})

    def test_fight_effective_damage(self):
        f, = build(self.fight(), 600)
        self.assertNotIn("edmg", f)  # no effective damage recorded: none, not 0
        self.assertNotIn("ed", f["players"]["Ragnar"])
        log = self.fight().g(60, e="edmg", p="Ragnar", i="Eikthyr", n=390).g(120, e="edmg", p="Ragnar", i="Eikthyr", n=130)
        log.g(60, e="edmg", p="Astrid", i="Eikthyr", n=260)
        f, = build(log, 600)
        self.assertEqual((f["dmg"], f["edmg"]), (600, 780))
        self.assertEqual({p: v["ed"] for p, v in f["players"].items()}, {"Ragnar": 520, "Astrid": 260})

    def test_fight_deaths_of_participants(self):
        log = self.fight().death(100, "Bjorn")  # died elsewhere at the same time: not part of this fight
        f, = build(log, 600)
        self.assertEqual([p for _, p in f["deaths"]], ["Astrid"])
        self.assertEqual(f["players"]["Astrid"]["x"], 1)

    def test_fight_retreat(self):
        log = Log().plugin(0, "1.15.0").g(60, e="dmg", p="Ragnar", i="Eikthyr", n=50)
        log.g(60 + 16 * 60, e="dmg", p="Ragnar", i="Eikthyr", n=70)  # after the gap: a new fight
        a, b = build(log, 2 * 3600)
        self.assertEqual((a["outcome"], a["dmg"], b["outcome"], b["dmg"]), ("retreat", 50, "retreat", 70))

    def test_fight_ongoing(self):
        log = Log().plugin(0, "1.15.0").g(60, e="dmg", p="Ragnar", i="Eikthyr", n=50)
        self.assertEqual(build(log, 120)[0]["outcome"], "ongoing")

    def test_fight_before_plugin_1_5_is_not_exact(self):
        log = Log().plugin(0, "1.4.0").g(60, e="dmg", p="Ragnar", i="Eikthyr", n=50)
        self.assertFalse(build(log, 120)[0]["exact"])

    def test_fight_all_parts(self):
        # Kall: three phases, dead when the last one is
        bosses = {"FrozenKing": {"boss": True}}
        log = Log().plugin(0, "1.15.0").g(60, e="kill", p="Ragnar", i="FrozenKing", n=1)
        f, = fights.build(log.events(), [], bosses, log.at(120))
        self.assertEqual(f["outcome"], "ongoing")
        log.g(180, e="kill", p="Ragnar", i="FrozenKing_p3", n=1)
        f, = fights.build(log.events(), [], bosses, log.at(240))
        self.assertEqual(f["outcome"], "killed")


if __name__ == "__main__":
    unittest.main()
