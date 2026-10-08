"""The collector's own loop (run_once, main) and the package as it's run: `python3 -m valheim_gamestats`."""
import contextlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import test_events
import test_rcon
from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import collector, events

PACKAGE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "collector")
SERVER = {"id": "test", "title": "Test", "game": "valheim",
          "rcon": {"host": "game", "port": 25575, "password_env": "GS_TEST_RCON_PASSWORD"}}


class GameServer:
    """ValheimRcon with the plugin, as the collector sees it: the event store and the recorded replies."""

    def __init__(self):
        self.store = test_events.Store(max_reply=3800)
        self.up = True

    def command(self, host, port, password, *cmds, timeout=10):
        if not self.up:
            raise ConnectionRefusedError(111, "Connection refused")
        out = []
        for cmd in cmds:
            if cmd.startswith("gs_events "):
                out.append(self.store.after(int(cmd.split()[1])))
            else:
                out.append(test_rcon.REPLIES[cmd])
        return out


class RunOnce(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.game = GameServer()
        st = self.game.store
        st.add(0, e="plugin", p="", i="1.20.4", n=1, hooks=15, of=15, failed=[])
        st.add(10, e="start", p="", i="W", n=1, game="l-1.0.17", backend="PlayFab")
        st.add(15, e="lobby", p="", i="active", n=1, code="017990")
        st.add(60, e="login", p="Ragnar", i="Steam_76561190000000001", n=1, uid=1001)
        st.add(60, e="spawn", p="Ragnar", i="", n=1, uid=1001)
        st.add(120, e="kill", p="Ragnar", i="Neck", n=2)
        self.cfg = {"interval": 60, "tz": "UTC", "servers": [SERVER], "plugin_version": "1.20.4"}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_once(self):
        out = io.StringIO()
        with mock.patch.object(collector, "DATA_DIR", self.dir), mock.patch.object(events.rcon, "command", self.game.command), \
                mock.patch.dict(os.environ, {"GS_TEST_RCON_PASSWORD": "pw"}), contextlib.redirect_stdout(out):
            collector.run_once(self.cfg)
        return out.getvalue()

    def site(self, *path):
        return os.path.join(self.dir, "site", "test", *path)

    def test_a_round(self):
        log = self.run_once()
        self.assertIn("[test] +6 events, 1 sessions, 1 online", log)
        index = read_json(self.site("index.json"))
        self.assertTrue(all(os.path.exists(self.site("c", n)) for n in index["files"]))
        self.assertEqual(read_json(os.path.join(self.dir, "test", "positions.json"))["connected"], ["Astrid", "Ragnar"])
        self.assertTrue(os.path.exists(os.path.join(self.dir, "test", "events.db")))

    def test_the_next_round_fetches_only_whats_new(self):
        self.run_once()
        self.game.store.add(180, e="kill", p="Ragnar", i="Neck", n=1)
        self.assertIn("[test] +1 events", self.run_once())

    def test_server_down(self):
        # nothing to read: the page keeps what it had, the alert waits for the server to stay down
        self.run_once()
        before = read_json(self.site("index.json"))
        self.game.up = False
        log = self.run_once()
        self.assertIn("events failed: ConnectionRefusedError", log)
        self.assertEqual(read_json(self.site("index.json")), before)
        self.assertIn("collector:events", read_json(os.path.join(self.dir, "test", "health.json"))["seen"])

    def test_server_down_reads_the_files(self):
        # with a Pelican panel, the plugin's event files are read while RCON is down
        self.run_once()
        self.game.store.add(180, e="kill", p="Ragnar", i="Neck", n=1)
        self.game.up = False
        store = self.game.store

        class Pelican:
            def __init__(self, cfg, key):
                pass

            def list(self, d):
                return {"store-id": {}, "2026-09-21.jsonl": {}}

            def get(self, path):
                return (store.id if path.endswith("store-id") else "\n".join(store.lines)).encode()

        self.cfg["servers"] = [{**SERVER, "world": {"panel": "p", "gateway": "g", "server": "s", "dir": "d", "manifest": "m"}}]
        with (mock.patch.object(collector.sources, "Pelican", Pelican),
              mock.patch.object(collector, "world_update", lambda *a: None),
              mock.patch.object(collector, "terrain_update", lambda *a: None),
              mock.patch.dict(os.environ, {"PELICAN_API_KEY": "k"})):
            log = self.run_once()
        self.assertIn("+1 events (from the files)", log)

    def test_a_failing_step_is_an_alert_not_a_crash(self):
        def broken(*a):
            raise RuntimeError("Steam is down")
        self.cfg["servers"] = [{**SERVER, "steam": {"app": 892970}}]
        with mock.patch.object(collector.steam, "update", broken), mock.patch.dict(os.environ, {"STEAM_API_KEY": "k"}):
            log = self.run_once()
        self.assertIn("steam update failed: RuntimeError: Steam is down", log)
        self.assertIn("collector:steam", read_json(os.path.join(self.dir, "test", "health.json"))["seen"])
        self.assertTrue(os.path.exists(self.site("index.json")))  # the rest went on


class Package(unittest.TestCase):
    """python3 -m valheim_gamestats, as the image runs it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.config = os.path.join(self.dir, "config.json")
        server = {**SERVER, "rcon": {**SERVER["rcon"], "host": "127.0.0.1", "port": 9}}  # nothing listens: refused at once
        with open(self.config, "w") as f:
            json.dump({"interval": 3600, "servers": [server]}, f)
        self.env = {**os.environ, "CONFIG": self.config, "DATA_DIR": os.path.join(self.dir, "data"), "PYTHONPATH": PACKAGE_DIR,
                    "GS_TEST_RCON_PASSWORD": "pw"}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_once(self):
        r = subprocess.run([sys.executable, "-m", "valheim_gamestats", "--once"], env=self.env, capture_output=True, text=True,
                           timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("[test] events failed:", r.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "data", "test", "health.json")))

    def test_stops_on_sigterm(self):
        # as PID 1 in a container: SIGTERM ends it between rounds, never in the middle of writing
        p = subprocess.Popen([sys.executable, "-m", "valheim_gamestats"], env=self.env, stdout=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 30
            while not os.path.exists(os.path.join(self.dir, "data", "test", "health.json")) and time.time() < deadline:
                time.sleep(0.1)
            p.send_signal(signal.SIGTERM)
            out, _ = p.communicate(timeout=30)
        finally:
            p.kill()
        self.assertEqual(p.returncode, 0)
        self.assertIn("SIGTERM, exiting", out)

    def test_every_file_goes_into_the_image(self):
        # .containerignore lets only what it names into the build: a package file it misses is missing in the image
        # (scoring.json was, in 1.20.7)
        import fnmatch
        root = os.path.join(PACKAGE_DIR, "..")
        with open(os.path.join(root, ".containerignore")) as f:
            rules = [line.strip() for line in f if line.strip() and not line.startswith("#")]

        def kept(path):
            keep = True
            for r in rules:
                neg, pat = r.startswith("!"), r.lstrip("!")
                if fnmatch.fnmatch(path, pat) or path.startswith(pat.rstrip("/") + "/"):
                    keep = neg
            return keep
        pkg = os.path.join(PACKAGE_DIR, "valheim_gamestats")
        files = [f"collector/valheim_gamestats/{n}" for n in os.listdir(pkg) if os.path.isfile(os.path.join(pkg, n))]
        self.assertIn("collector/valheim_gamestats/scoring.json", files)
        self.assertEqual([f for f in files if not kept(f)], [])

    def test_version(self):
        import valheim_gamestats
        with open(os.path.join(os.path.dirname(__file__), "..", "..", "chart", "valheim-gamestats", "Chart.yaml")) as f:
            chart = next(line.split(":", 1)[1].strip() for line in f if line.startswith("version:"))
        self.assertEqual(valheim_gamestats.__version__, chart)


if __name__ == "__main__":
    unittest.main()
