"""Where the game server's files come from (sources.py): Pelican, a local directory or a script — and the world save,
the terrain and the event files read through the latter two, end to end. examples/sources/ssh.sh is run for real,
against an `ssh` that runs the remote command locally."""
import contextlib
import io
import os
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

import test_build
import test_events
from logs import read_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import collector, events, sources

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
SSH_EXAMPLE = os.path.realpath(os.path.join(ROOT, "examples", "sources", "ssh.sh"))
WDIR = ".config/unity3d/IronGate/Valheim/worlds_local/Dedicated"
MANIFEST = "valheim_server_Data/StreamingAssets/SoftRef/manifest_extended"


def server_dir(base):
    """A game server's directory as the collector finds it: the world save, the game's manifest, the plugin's output."""
    files = test_build.Pelican({}, "").files  # the same files the build test serves through Pelican
    for path, body in files.items():
        if path.startswith(test_build.WDIR + "/"):
            path = WDIR + path[len(test_build.WDIR):]
        elif path == test_build.MANIFEST:
            path = MANIFEST
        os.makedirs(os.path.dirname(os.path.join(base, path)), exist_ok=True)
        with open(os.path.join(base, path), "wb") as f:
            f.write(body)
    store = test_events.Store()
    store.add(0, e="plugin", p="", i="1.20.5", n=1).add(60, e="kill", p="Ragnar", i="Neck", n=3)
    ev = os.path.join(base, "BepInEx", "gamestats", "events")
    os.makedirs(ev)
    with open(os.path.join(ev, "store-id"), "w") as f:
        f.write(store.id + "\n")
    with open(os.path.join(ev, "2026-09-21.jsonl"), "w") as f:
        f.write("\n".join(store.lines) + "\n")
    return store


class Choose(unittest.TestCase):
    def test_none(self):
        self.assertIsNone(sources.source(None))

    def test_exactly_one(self):
        for bad in ({"dir": "x"}, {"path": "/a", "script": "b"}):
            with self.assertRaisesRegex(ValueError, "exactly one"):
                sources.source(bad)

    def test_kinds(self):
        self.assertIsInstance(sources.source({"path": "/srv"}), sources.LocalFiles)
        self.assertIsInstance(sources.source({"script": "x.sh a 'b c'"}), sources.ScriptSource)
        self.assertEqual(sources.source({"script": "x.sh a 'b c'"}).argv, ["x.sh", "a", "b c"])
        with mock.patch.dict(os.environ, {"PELICAN_API_KEY": "k"}):
            self.assertIsInstance(sources.source({"panel": "http://p", "gateway": "http://g", "server": "s"}), sources.Pelican)

    def test_pelican_needs_its_key(self):
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, "PELICAN_API_KEY"):
            sources.source({"panel": "http://p", "gateway": "http://g", "server": "s"})


class Local(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "BepInEx", "gamestats", "sub"))
        with open(os.path.join(self.dir, "BepInEx", "gamestats", "terrain.json"), "wb") as f:
            f.write(b'{"file":"x"}')
        os.utime(os.path.join(self.dir, "BepInEx", "gamestats", "terrain.json"), (1790000000, 1790000000))
        self.src = sources.LocalFiles(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_list_files_only(self):
        self.assertEqual(self.src.list("BepInEx/gamestats"),
                         {"terrain.json": {"name": "terrain.json", "modified_at": "2026-09-21T14:13:20Z"}})

    def test_get(self):
        self.assertEqual(self.src.get("BepInEx/gamestats/terrain.json"), b'{"file":"x"}')

    def test_absolute_paths_as_they_are(self):
        # a plain install keeps its save in the server user's home, not below the server directory
        self.assertIn("terrain.json", self.src.list(os.path.join(self.dir, "BepInEx", "gamestats")))

    def test_no_way_out(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            self.src.get("../../etc/passwd")

    def test_missing_is_an_os_error(self):
        with self.assertRaises(OSError):
            self.src.list("BepInEx/nothing")


class Script(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.script = os.path.join(self.dir, "source.py")
        with open(self.script, "w") as f:
            f.write('''import json, sys
files = {"a b.txt": b"hello", "bin": bytes(range(256))}
op, path = sys.argv[-2:]
if sys.argv[1] == "--fail":
    sys.stderr.write("no route to host\\n"); sys.exit(3)
if op == "list":
    form = sys.argv[1]
    if form == "dict":
        print(json.dumps({n: {"modified_at": "2026-09-21T14:13:20Z"} for n in files}))
    else:
        print(json.dumps([{"name": n, "modified_at": 1790000000} for n in files]))
else:
    sys.stdout.buffer.write(files[path.rsplit("/", 1)[-1]])
''')

    def tearDown(self):
        shutil.rmtree(self.dir)

    def src(self, *args):
        return sources.ScriptSource([sys.executable, self.script, *args])

    def test_list_both_forms(self):
        want = {n: {"name": n, "modified_at": "2026-09-21T14:13:20Z"} for n in ("a b.txt", "bin")}
        self.assertEqual(self.src("dict").list("d"), want)
        self.assertEqual(self.src("list").list("d"), want)  # epoch seconds become ISO 8601

    def test_get_bytes(self):
        self.assertEqual(self.src("x").get("d/bin"), bytes(range(256)))
        self.assertEqual(self.src("x").get("d/a b.txt"), b"hello")

    def test_failure_says_why(self):
        with self.assertRaisesRegex(OSError, "no route to host"):
            self.src("--fail").list("d")


class EndToEnd(unittest.TestCase):
    """World save, terrain and the event files of a server directory, through the local source and the SSH example."""

    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.game = os.path.join(self.base, "valheim server")  # a space: paths get quoted on their way
        self.store = server_dir(self.game)
        self.data = os.path.join(self.base, "data")
        self.sdir = os.path.join(self.data, "test")
        os.makedirs(self.sdir)

    def tearDown(self):
        shutil.rmtree(self.base)

    def run_all(self, world):
        server = {"id": "test", "world": {**world, "dir": WDIR, "manifest": MANIFEST},
                  "rcon": {"host": "game", "password_env": "X"}}
        out = io.StringIO()
        refused = mock.Mock(side_effect=ConnectionRefusedError(111, "Connection refused"))
        with mock.patch.object(collector, "DATA_DIR", self.data), mock.patch.object(events.rcon, "command", refused), \
                contextlib.redirect_stdout(out):
            collector.world_update(server, {}, self.sdir)
            collector.terrain_update(server, self.sdir)
            status, evs = collector.collect(server, self.sdir)  # RCON down: the event files
        top = read_json(os.path.join(self.sdir, "world.json"))["pieces"]["Ragnar"]["top"]
        self.assertIn("woodwall", [n for n, _ in top])  # the save, read and parsed
        self.assertEqual(read_json(os.path.join(self.sdir, "terrain.json"))["size"], 4)
        self.assertTrue(os.path.exists(os.path.join(self.data, "site", "test", "terrain.png")))
        self.assertEqual((status["files"], status["added"]), (True, 2))
        self.assertEqual([e["e"] for e in evs], ["plugin", "kill"])
        return out.getvalue()

    def test_local(self):
        self.run_all({"path": self.game})

    def test_ssh_example(self):
        # an `ssh` that runs the remote command here: the example script, its quoting and its listing for real
        bindir = os.path.join(self.base, "bin")
        os.makedirs(bindir)
        fake = os.path.join(bindir, "ssh")
        with open(fake, "w") as f:
            f.write('#!/bin/sh\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec sh -c "$*"\n')
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        with mock.patch.dict(os.environ, {"PATH": bindir + os.pathsep + os.environ["PATH"]}):
            self.run_all({"script": [SSH_EXAMPLE, "valheim@game.example.com", self.game]})


if __name__ == "__main__":
    unittest.main()
