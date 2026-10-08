"""RCON (rcon.py): ValheimRcon's and the plugin's replies — recorded from a real server, names anonymized
(fixtures/rcon.json) — into positions, gear, tombstone levels, live portals, the world clock and global keys."""
import json
import os
import shutil
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import rcon

REPLIES = read_json(os.path.join(os.path.dirname(__file__), "fixtures", "rcon.json"))
SERVER = {"id": "test", "rcon": {"host": "game", "port": 25575, "password_env": "RCON_TEST"}}
ORDER = ("players", "globalKeys", "time", "equipment", "tombstones", "portals")


class Parse(unittest.TestCase):
    def test_players(self):
        ps = rcon.parse_players(REPLIES["players"])
        self.assertEqual([(p["name"], round(p["x"]), round(p["z"]), p["public"]) for p in ps],
                         [("Ragnar", 46, 514, True), ("Astrid", 40, 516, True)])

    def test_players_decimal_comma(self):
        # the plugin formats numbers with the server's culture
        p, = rcon.parse_players("Online 1\nRagnar Steam ID:Steam_1 Position: (46,5 32,6 514,2) Zone: (1 8) "
                                "Public position: False")
        self.assertEqual((p["x"], p["z"], p["public"]), (46.5, 514.2, False))

    def test_players_not_spawned_yet(self):
        self.assertEqual(rcon.parse_players("Online 1\n Steam ID:Steam_1 Position: (0 0 0) Zone: (0 0) Public position: False"),
                         [])

    def test_keys_as_in_the_save(self):
        keys = rcon.parse_keys(REPLIES["globalKeys"])
        self.assertIn("activebosses 0", keys)
        self.assertIn("defeated_goblinking", keys)
        self.assertEqual(keys, sorted(keys))

    def test_time(self):
        self.assertAlmostEqual(rcon.parse_time(REPLIES["time"]), 544371.82, places=2)

    def test_unexpected_replies_fail_loudly(self):
        for f, bad in ((rcon.parse_players, "Unknown command"), (rcon.parse_keys, "nope"), (rcon.parse_time, "")):
            with self.assertRaises(ValueError):
                f(bad)


class Update(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.replies = dict(REPLIES)
        self.now = 1_791_400_000

    def tearDown(self):
        shutil.rmtree(self.dir)

    def poll(self, dt=60):
        self.now += dt
        with mock.patch.dict(os.environ, {"RCON_TEST": "pw"}), \
                mock.patch.object(rcon, "command", lambda h, p, pw, *cmds: [self.replies[c] for c in cmds]), \
                mock.patch.object(rcon.time, "time", lambda: self.now):
            rcon.update(SERVER, self.dir)

    def state(self, name):
        return read_json(os.path.join(self.dir, name))

    def test_positions_only_for_public(self):
        self.replies["players"] = REPLIES["players"].replace("Public position: True Platform name: player\nAstrid",
                                                             "Public position: False Platform name: player\nAstrid")
        self.poll()
        st = self.state("positions.json")
        self.assertEqual((sorted(st["players"]), st["online"], st["connected"]), (["Astrid"], ["Astrid"], ["Astrid", "Ragnar"]))
        pub = rcon.public(self.dir, self.now, 60)
        self.assertEqual([(p["p"], p["online"]) for p in pub["players"]], [("Astrid", True)])
        self.assertFalse(rcon.public(self.dir, self.now + 600, 60)["live"])  # polls stopped: nobody counts as online

    def test_no_steam_ids_kept(self):
        self.poll()
        for f in os.listdir(self.dir):
            self.assertNotIn("Steam_", Path(self.dir, f).read_text(), f)

    def test_keys_first_seen_between_polls(self):
        self.replies["globalKeys"] = REPLIES["globalKeys"].replace("defeated_goblinking :", "")
        self.poll()
        t0 = self.now
        self.replies["globalKeys"] = REPLIES["globalKeys"]
        self.poll()
        live = rcon.live_world(self.dir, self.now, 60)
        self.assertEqual(live["first"], {"defeated_goblinking": [t0, self.now]})
        self.assertAlmostEqual(live["time"], 544371.8)

    def test_gear_and_usage(self):
        self.poll()
        self.poll()
        eq = rcon.equipment(self.dir, self.now, 60)
        self.assertEqual(eq["Ragnar"]["slots"]["helmet"]["item"], "HelmetCarapace")
        self.assertEqual(eq["Ragnar"]["usage"]["helmet"]["HelmetCarapace"]["s"], 120)  # two polls of a minute
        self.assertIn("look", eq["Ragnar"])
        self.assertTrue(eq["Astrid"]["online"])

    def test_tombstone_level_at_last_death(self):
        self.poll()
        tombs = self.state("tombstones.json")
        self.assertEqual(set(tombs["owners"].values()), {"Ragnar"})
        self.assertEqual(tombs["levels"]["Ragnar"]["MaceBronze"]["q"], 3)

    def test_tombstone_new_is_seen_now(self):
        self.poll()
        tb = json.loads(REPLIES["tombstones"])
        tb.append({"id": "1:999", "owner": "Astrid", "died": 544300, "items": [{"item": "HelmetPadded", "q": 2}]})
        self.replies["tombstones"] = json.dumps(tb)
        self.poll()
        tombs = self.state("tombstones.json")
        self.assertEqual((tombs["seen"]["1:999"], tombs["owners"]["1:999"]), (self.now, "Astrid"))

    def test_portals_live(self):
        self.poll()
        pl = rcon.portals(self.dir, self.now, 60)
        tag, x, z, partner = pl["list"][0]
        self.assertEqual((x % 64, z % 64), (0, 0))  # snapped to the zone like everything players build
        self.assertIsNone(rcon.portals(self.dir, self.now + 600, 60))  # stale: the page falls back to the save

    def test_without_the_plugin(self):
        for k in ("equipment", "tombstones", "portals"):
            self.replies[k] = "Unknown command " + k
        self.poll()
        self.assertFalse(os.path.exists(os.path.join(self.dir, "equipment.json")))
        self.assertIsNone(rcon.equipment(self.dir, self.now, 60))
        self.assertTrue(rcon.public(self.dir, self.now, 60)["live"])  # ValheimRcon's own commands still work


class Wire(unittest.TestCase):
    """The Source RCON protocol against a local fake server."""

    def serve(self, password, replies):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)

        def run():
            with srv:
                conn, _ = srv.accept()
            with conn:
                def read():
                    n = struct.unpack("<i", conn.recv(4))[0]
                    data = b""
                    while len(data) < n:
                        data += conn.recv(n - len(data))
                    rid, kind = struct.unpack("<ii", data[:8])
                    return rid, kind, data[8:-2].decode()

                def send(rid, kind, body):
                    b = struct.pack("<ii", rid, kind) + body.encode() + b"\0\0"
                    conn.sendall(struct.pack("<i", len(b)) + b)

                rid, kind, body = read()
                send(rid if body == password else -1, 2, "")
                if body != password:
                    return
                for _ in replies:
                    rid, kind, cmd = read()
                    send(rid, 0, replies[cmd])
        threading.Thread(target=run, daemon=True).start()
        return srv.getsockname()[1]

    def test_session(self):
        port = self.serve("pw", {"time": REPLIES["time"], "players": REPLIES["players"]})
        self.assertEqual(rcon.command("127.0.0.1", port, "pw", "time", "players"), [REPLIES["time"], REPLIES["players"]])

    def test_wrong_password(self):
        port = self.serve("pw", {})
        with self.assertRaises(PermissionError):
            rcon.command("127.0.0.1", port, "nope", "time")


if __name__ == "__main__":
    unittest.main()
