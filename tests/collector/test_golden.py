"""The whole collector on a made-up two days: archive → events.db → build() → data.json, compared to
tests/collector/golden/data.json.

Any change in what the page gets shows up here as a diff. Intended? Regenerate and review the diff:

    UPDATE_GOLDEN=1 python3 -m unittest discover -s tests/collector
"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from logs import Log  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import chunks, collector, events, notify, scoring

HOUR, DAY = 3600, 86400
GOLDEN = os.path.join(os.path.dirname(__file__), "golden", "data.json")
SERVER = {"id": "test", "title": "Test Valheim", "game": "valheim", "notify": {"url": "https://stats.example.com/"},
          "maintenance": [{"from": "2026-09-22T03:00:00Z", "to": "2026-09-22T03:30:00Z", "note": "update"}],
          "support": {"url": "https://example.com/support", "label": "Support"}}
CFG = {"interval": 60, "tz": "Europe/Berlin", "servers": [SERVER]}


def scenario():
    """Ragnar explores alone while Astrid builds at home; they fight Eikthyr together; Bjorn drops by."""
    log = Log().restart(0).plugin(-50, "1.15.0")
    log.connect(30, "76561190000000001").spawn(60, "Ragnar", 1001).connect(80, "76561190000000002").spawn(120, "Astrid", 1002)
    for name in ("Ragnar", "Astrid"):
        log.minutes(180, 4 * HOUR, name, e="peak", i="hp", n=110 if name == "Ragnar" else 95)
        log.minutes(180, 4 * HOUR, name, e="dist", i="foot", n=150)
    log.minutes(180, HOUR, "Astrid", e="pick", i="Wood", n=12)
    log.minutes(180, HOUR, "Ragnar", e="pick", i="Stone", n=4)
    log.g(400, e="fell", p="Astrid", i="Beech1", n=2).g(500, e="mine", p="Ragnar", i="Rock4", n=1)
    # exploration: Ragnar alone, a zone with a location and two without
    log.location(900, "Crypt3", 12, -9).zone(901, 12, -9, ["Ragnar"]).zone(960, 13, -9, ["Ragnar"]).zone(1020, 13, -8, ["Ragnar"])
    log.g(1500, e="enter", p="Ragnar", i="Crypt3", x=780, z=-560, n=1).g(1900, e="leave", p="Ragnar", i="Crypt3", x=780, z=-560,
                                                                        n=1, s=400)
    log.g(1960, e="take", p="Ragnar", i="SwordIron", q=2, c="", k="world chest", x=790, z=-570, n=1)
    log.g(1960, e="loot", p="Ragnar", i="Coins", n=55)
    # combat
    for t, mob in ((2400, "Greyling"), (2460, "Greyling"), (2520, "Neck")):
        log.g(t, e="dmg", p="Ragnar", i=mob, n=40).g(t, e="kill", p="Ragnar", i=mob, n=1)
        log.g(t, e="kw", p="Ragnar", i=f"AxeFlint>{mob}", n=1).g(t, e="wkill", p="Ragnar", i="AxeFlint", n=1)
    log.g(2520, e="taken", p="Ragnar", i="", n=30).g(2520, e="hit", p="Ragnar", i="", n=3)
    log.g(2520, e="peak", p="Ragnar", i="hit", n=22)
    log.death(2600, "Ragnar").spawn(2630, "Ragnar", 1001, 2)
    log.g(3000, e="sprint", p="Ragnar", n=1, m=42.5, s=8).g(3100, e="fall", p="Astrid", n=1, h=12.4)
    log.g(3200, e="closecall", p="Ragnar", n=1, hp=4.1, max=110)
    # Eikthyr, together
    log.g(3 * HOUR, e="dmg", p="Ragnar", i="Eikthyr", n=300).g(3 * HOUR, e="dw", p="Ragnar", i="AxeFlint>Eikthyr", n=300)
    log.g(3 * HOUR, e="dmg", p="Astrid", i="Eikthyr", n=200).g(3 * HOUR, e="dw", p="Astrid", i="Bow>Eikthyr", n=200)
    log.g(3 * HOUR + 60, e="kill", p="Ragnar", i="Eikthyr", n=1).g(3 * HOUR + 60, e="kill", p="Astrid", i="Eikthyr", n=1)
    log.raid(3 * HOUR + 600, "army_eikthyr")
    log.logout(4 * HOUR, 1001).logout(4 * HOUR + 30, 1002).players(4 * HOUR + 60, 0)
    # planned restart, the next day Bjorn alone; a zone from before the plugin's zone line would look like this
    log.restart(DAY).plugin(DAY - 50, "1.15.0").spawn(DAY + 60, "Bjorn", 1003)
    log.minutes(DAY + 120, DAY + 2 * HOUR, "Bjorn", e="peak", i="hp", n=80)
    log.raw(DAY + 1000, "Time 7394.8, day:3    nextm:7470.0  skipspeed:6.2")
    return log


def served(site):
    """What the page gets: index.json and the files it names, joined (chunks.merge)."""
    with open(os.path.join(site, "index.json")) as f:
        index = json.load(f)
    files = {}
    for n in index["files"]:
        with open(os.path.join(site, "c", n)) as f:
            files[n] = json.load(f)
    return chunks.merge(index, files)


def build(now):
    data_dir = tempfile.mkdtemp()
    try:
        sdir = os.path.join(data_dir, "test")
        os.makedirs(sdir)
        os.makedirs(os.path.join(data_dir, "icons", "valheim"))
        with open(os.path.join(data_dir, "icons", "valheim", "creatures.json"), "w") as f:  # tools/extract_gamedata.py
            json.dump({"Eikthyr": {"boss": True}, "Greyling": {}, "Neck": {}}, f)
        with open(os.path.join(sdir, "archive.jsonl"), "w") as f:
            for row in scenario().rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        # the way a server's history arrives: the old log archive, imported once into events.db up to the plugin
        # store's first event (here: after the scenario)
        db = events.open_db(sdir)
        with db:
            events.set_meta(db, "cutover", now)
        with contextlib.redirect_stdout(io.StringIO()):
            events.import_archive(db, sdir)
        evs = events.load(db)
        db.close()
        with mock.patch.object(collector, "DATA_DIR", data_dir), mock.patch.object(collector.time, "time", lambda: now):
            data = collector.build(SERVER, CFG, sdir, evs)
            assert served(os.path.join(data_dir, "site", "test")) == json.loads(json.dumps(data))
            assert not os.path.exists(os.path.join(data_dir, "site", "test", "data.json"))  # only the pieces since 1.20.4
            return data, sdir, data_dir
    except BaseException:
        shutil.rmtree(data_dir)
        raise


class Golden(unittest.TestCase):
    def setUp(self):
        self.now = Log().at(1 * DAY + 3 * HOUR)
        self.data, self.sdir, self.dir = build(self.now)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_golden(self):
        got = json.loads(json.dumps(self.data))
        # the rules are scoring.json as it is (test_scoring checks them): left out, so changing a default isn't a golden diff
        self.assertEqual(got.pop("scoring"), scoring.publish({}, {}))
        if os.environ.get("UPDATE_GOLDEN"):
            os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
            with open(GOLDEN, "w") as f:
                json.dump(got, f, ensure_ascii=False, indent=1, sort_keys=True)
                f.write("\n")
        with open(GOLDEN) as f:
            want = json.load(f)
        for key in sorted(set(want) | set(got)):
            self.assertEqual(got.get(key), want.get(key), f"data.json key {key!r} changed (UPDATE_GOLDEN=1 to accept)")

    def test_golden_credit(self):
        # the incidents, end to end: Astrid was online all along and never near the new zones
        self.assertTrue(all(z["by"] == ["Ragnar"] and z["exact"] for z in self.data["zones"]))
        kills = {}
        for _, p, e, _, n in self.data["gather"]:
            if e == "kill":
                kills[p] = kills.get(p, 0) + n
        self.assertEqual(kills, {"Ragnar": 4, "Astrid": 1})
        fight, = self.data["fights"]
        self.assertEqual({p: v["k"] for p, v in fight["players"].items()}, {"Ragnar": 1, "Astrid": 1})

    def test_notify(self):
        # the Discord feed runs on the same data without failing (dry: nothing is posted)
        with contextlib.redirect_stdout(io.StringIO()):  # notify takes "now" from data["generated"]
            state = notify.run(SERVER, self.sdir, self.data, dry=True)
        self.assertIn("standings", state)


if __name__ == "__main__":
    unittest.main()
