"""The collector end to end, with every source a server can have: events (the golden scenario plus pets and a
login), the world save through Pelican (worldsave.World), the plugin's terrain sample, RCON (recorded replies) and
Steam (canned) — into data.json. Every key the page reads must come out, each from its own source
(docs/events.json "data" names this test for the keys nothing else builds)."""
import contextlib
import gzip
import io
import json
import os
import shutil
import struct
import tempfile
import unittest
from unittest import mock

import test_golden
import test_rcon
import test_steam
from logs import read_json  # first: puts collector/ (the package's directory) on the path
from worldsave import World, item  # also: puts collector/ on the path

from valheim_gamestats import collector, notify, rcon, steam

HOUR, DAY = 3600, 86400
WDIR, MANIFEST, TDIR = "worlds", "Managed/manifest", "BepInEx/gamestats"
SERVER = {**test_golden.SERVER,
          "world": {"panel": "http://panel", "gateway": "http://gw", "server": "abcd", "dir": WDIR, "manifest": MANIFEST,
                    "interval": 3600},
          "rcon": {"host": "game", "port": 25575, "password_env": "RCON_TEST"},
          "steam": {"app": 892970, "interval": 600},
          "notify": {"url": "https://stats.example.com/", "webhook_env": "NOTIFY_TEST"}}
CONTRACT = read_json(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "events.json"))


def world():
    return (World(net_time=500_000.0)
            .piece("piece_chest_wood", 100, 200, creator=1001, items=[item("SwordIron", quality=3, crafter="Astrid", cid=1002)])
            .piece("woodwall", 110, 200, creator=1001)
            .tame("Wolf", 120, 210, name="Fenrir", spawntime=123456)
            .portal("home", 130, 220)
            .bed(1001, "Ragnar", 100, 210)
            .tombstone("Ragnar", [item("AxeFlint", quality=2)], 400_000, 300, 300)
            .table(bytes([1, 0, 0, 1]), [("Base", 1, 100.0, 200.0)])
            .keys(["defeated_eikthyr"])
            .location("Eikthyrnir", 500, 500)
            .generated((1, 3), (2, 3)))


def terrain_blob(size=4, extent=512.0, seed=42):
    heights = struct.pack(f"<{size * size}h", *([400] * (size * size)))
    return gzip.compress(b"GSTR" + struct.pack("<iifi", 1, size, extent, seed) + heights + bytes([1] * (size * size)))


class Pelican:
    """The Pelican client API: directory listings and downloads."""

    def __init__(self, cfg, key):
        files, names = world().files()
        self.files = {**{f"{WDIR}/{n}": b for n, b in files.items()},
                      MANIFEST: b"\n".join(f"Assets/GameElements/{n}.prefab".encode() for n in names.values()),
                      f"{TDIR}/terrain.json": json.dumps({"file": "terrain-42.bin.gz", "t": 1790000000}).encode(),
                      f"{TDIR}/terrain-42.bin.gz": terrain_blob()}

    def list(self, d):
        return {p.rsplit("/", 1)[1]: {"name": p.rsplit("/", 1)[1], "modified_at": "2026-09-21T00:00:00Z"}
                for p in self.files if p.rsplit("/", 1)[0] == d}

    def get(self, path):
        return self.files[path]


def scenario():
    log = test_golden.scenario()
    pet = "Wolf:123456"
    log.g(2 * HOUR, e="pethp", p="Fenrir", i="Wolf", n=1, k=pet, dmg=40, hits=2, heal=0, min=60, hp=60, max=100,
          by={"~Greyling": 40})
    log.g(2 * HOUR + 60, e="petdeath", p="Fenrir", i="Wolf", n=1, k=pet, x=120, z=210, hp=0, lv=0, by=[], near="Greyling", nd=3)
    log.g(DAY + 70, e="login", p="Bjorn", i="Steam_76561190000000003", n=1, uid=1003)
    return log


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.sdir = os.path.join(cls.dir, "test")
        os.makedirs(os.path.join(cls.dir, "icons", "valheim"))
        os.makedirs(cls.sdir)
        with open(os.path.join(cls.dir, "icons", "valheim", "creatures.json"), "w") as f:
            json.dump({"Eikthyr": {"boss": True}}, f)
        cls.now = test_golden.Log().at(DAY + 3 * HOUR)
        env = {"PELICAN_API_KEY": "k", "RCON_TEST": "pw", "STEAM_API_KEY": "k", "NOTIFY_TEST": "https://discord.invalid/hook"}
        replies = dict(test_rcon.REPLIES)
        # the first poll only learns the keys there are; one that appears by the next poll gets that window
        replies["globalKeys"] = test_rcon.REPLIES["globalKeys"].replace("defeated_goblinking :", "")
        cls.posts = []
        with mock.patch.dict(os.environ, env), mock.patch.object(collector, "DATA_DIR", cls.dir), \
                mock.patch.object(collector.sources, "Pelican", Pelican), \
                mock.patch.object(collector.time, "time", lambda: cls.now), \
                mock.patch.object(rcon.time, "time", lambda: cls.now), \
                mock.patch.object(rcon, "command", lambda h, p, pw, *cmds: [replies[c] for c in cmds]), \
                mock.patch.object(steam, "_get", test_steam.api), mock.patch.object(steam, "_icon", lambda *a: None), \
                mock.patch.object(steam.time, "time", lambda: cls.now), \
                mock.patch.object(notify, "post", lambda url, user, embeds: cls.posts.extend(embeds)), \
                mock.patch.object(notify.time, "sleep", lambda s: None), contextlib.redirect_stdout(io.StringIO()):
            collector.world_update(SERVER, {}, cls.sdir)
            collector.terrain_update(SERVER, cls.sdir)
            rcon.update(SERVER, cls.sdir)
            replies["globalKeys"] = test_rcon.REPLIES["globalKeys"]
            rcon.update(SERVER, cls.sdir)
            evs = scenario().events()
            collector.build(SERVER, test_golden.CFG, cls.sdir, evs)  # learns the accounts (login) for Steam
            steam.update(SERVER, cls.sdir, cls.dir, "k")
            data = collector.build(SERVER, test_golden.CFG, cls.sdir, evs)
            notify.run(SERVER, cls.sdir, data)  # the trading cards it keeps come back in the next build
            cls.data = collector.build(SERVER, test_golden.CFG, cls.sdir, evs)
        cls.served = test_golden.served(os.path.join(cls.dir, "site", "test"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir)

    def test_every_key_the_page_reads(self):
        want = set(CONTRACT["data"])
        self.assertEqual(set(self.served) - want, set(), "keys in data.json that docs/events.json doesn't know")
        self.assertEqual(want - set(self.served), set(), "keys docs/events.json promises that didn't come out")
        empty = [k for k, v in self.served.items() if v in ([], {}, None) and k not in ("online",)]
        self.assertEqual(empty, [], "every source given, so nothing should be empty")

    def test_world(self):
        w = self.data["world"]
        self.assertTrue({"woodwall", "piece_chest_wood", "portal_wood"} <= {n for n, _ in w["pieces"]["Ragnar"]["top"]})
        self.assertEqual(w["items"]["SwordIron"]["crafted"], {"Astrid": 1})
        self.assertEqual((w["beds"], w["tombstones"]), ({"Ragnar": 1}, {"Ragnar": 1}))
        self.assertNotIn("pets", w)  # published as data["pets"], without platform ids
        self.assertTrue(os.path.exists(os.path.join(self.dir, "site", "test", "explored.png")))

    def test_world_history(self):
        h, = self.data["world_history"]
        self.assertEqual((h["zones"], list(h["pieces"]), h["keys"]), (2, ["Ragnar"], ["defeated_eikthyr"]))  # the save's own keys

    def test_pets(self):
        p, = self.data["pets"]
        self.assertEqual((p["k"], p["n"], p["status"], p["death"]["near"]), ("Wolf:123456", "Fenrir", "dead", "Greyling"))
        self.assertEqual(p["hurt"]["by"], {"~Greyling": 40})

    def test_terrain(self):
        self.assertEqual(self.data["terrain"], {"v": 1790000000, "size": 4, "extent": 512.0})
        with open(os.path.join(self.dir, "site", "test", "terrain.png"), "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")

    def test_live_from_rcon(self):
        self.assertEqual([p["p"] for p in self.data["positions"]["players"]], ["Astrid", "Ragnar"])
        self.assertIn("helmet", self.data["equipment"]["Ragnar"]["slots"])
        self.assertTrue(self.data["portals_live"]["list"])
        self.assertEqual(self.data["clock"]["src"], "rcon")
        self.assertIn("defeated_goblinking", self.data["world"]["keys"])  # the live keys replace the save's
        self.assertEqual(list(self.data["key_times"]), ["defeated_goblinking"])

    def test_steam(self):
        # Ragnar and Astrid from the old log's pairing, Bjorn from the plugin's login
        self.assertEqual(sorted(self.data["steam"]["players"]), ["Astrid", "Bjorn", "Ragnar"])
        self.assertNotIn("7656119000000000", json.dumps(self.served))

    def test_cards(self):
        self.assertTrue(self.data["cards"])


if __name__ == "__main__":
    unittest.main()
