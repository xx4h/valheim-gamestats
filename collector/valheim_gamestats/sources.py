"""Where the collector reads the game server's files: the world save, the plugin's terrain sample and — while RCON can't
be reached — the plugin's event files. A server's `world` block names one source:

  panel: …   pelican  the Pelican panel's client API (read-only file permission; PELICAN_API_KEY)
  path: …    local    a directory the collector can read (the server's directory, mounted or on the same machine)
  script: …  script   any command that lists and reads files — ssh, rsync, an object store, …: see ScriptSource

Every source answers the same two calls, with paths relative to the server's directory (or absolute):
  list(directory) -> {name: {"name": name, "modified_at": ISO 8601}}   the files in it
  get(path) -> bytes                                                    one file

Stdlib only.
"""
import json
import os
import shlex
import subprocess
import urllib.parse
import urllib.request
from datetime import UTC, datetime

KINDS = ("panel", "path", "script")


def source(wcfg):
    """The source a server's `world` block names, or None when there's no world block. Raises on a block that names
    none or several, and when Pelican's key is missing."""
    if not wcfg:
        return None
    named = [k for k in KINDS if wcfg.get(k)]
    if len(named) != 1:
        raise ValueError(f"world: set exactly one of panel (Pelican), path (local) or script, not {named or 'none'}")
    if named[0] == "path":
        return LocalFiles(wcfg["path"])
    if named[0] == "script":
        return ScriptSource(wcfg["script"])
    key = os.environ.get("PELICAN_API_KEY")
    if not key:
        raise ValueError("world: Pelican needs PELICAN_API_KEY")
    return Pelican(wcfg, key)


def _iso(ts):
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


class Pelican:
    """Pelican client API, read-only (in-cluster, no hairpin): the panel signs a download URL, the gateway serves it."""

    def __init__(self, cfg, key):
        self.panel = cfg["panel"].rstrip("/")
        self.gateway = cfg["gateway"].rstrip("/")
        self.server = cfg["server"]
        self.headers = {"Authorization": f"Bearer {key}", "Accept": "application/json",
                        "Host": cfg.get("panel_host", ""), "X-Forwarded-Proto": "https"}

    def _api(self, path):
        req = urllib.request.Request(f"{self.panel}/api/client/servers/{self.server}{path}", headers=self.headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)

    def list(self, directory):
        out = {}
        for f in self._api("/files/list?directory=" + urllib.parse.quote(directory))["data"]:
            a = f["attributes"]
            out[a["name"]] = a
        return out

    def get(self, path):
        url = urllib.parse.urlsplit(self._api("/files/download?file=" + urllib.parse.quote(path))["attributes"]["url"])
        with urllib.request.urlopen(f"{self.gateway}{url.path}?{url.query}", timeout=300) as r:
            return r.read()


class LocalFiles:
    """A directory: the game server's own, mounted read-only into the collector, or on the same machine. Relative paths
    stay inside it (a `..` that climbs out is refused); absolute ones are taken as they are — the save of a plain
    server install usually lives outside it, in the server user's ~/.config/unity3d/IronGate/Valheim."""

    def __init__(self, root):
        self.root = os.path.realpath(root)

    def _path(self, p):
        if os.path.isabs(p):
            return p
        full = os.path.realpath(os.path.join(self.root, p))
        if full != self.root and not full.startswith(self.root + os.sep):
            raise ValueError(f"local files: {p!r} is outside {self.root}")
        return full

    def list(self, directory):
        out = {}
        with os.scandir(self._path(directory)) as it:
            for e in it:
                if e.is_file():
                    out[e.name] = {"name": e.name, "modified_at": _iso(e.stat().st_mtime)}
        return out

    def get(self, path):
        with open(self._path(path), "rb") as f:
            return f.read()


class ScriptSource:
    """Any command, for every other way to reach the files. It's run without a shell (the command is split like a shell
    would) with two more arguments:

      <command> list <directory>   stdout: JSON — {name: {"modified_at": …}} or [{"name", "modified_at"}], the time
                                   as ISO 8601 or as seconds since the epoch
      <command> get <path>         stdout: the file's bytes

    A non-zero exit is an error (its stderr is in the message). Paths are as the collector uses them: relative to the
    server's directory, or absolute. examples/sources/ssh.sh is one for a server reachable over SSH."""

    TIMEOUT = 300

    def __init__(self, command):
        self.argv = shlex.split(command) if isinstance(command, str) else list(command)

    def _run(self, *args):
        r = subprocess.run([*self.argv, *args], capture_output=True, timeout=self.TIMEOUT, check=False)
        if r.returncode != 0:
            raise OSError(f"source script {self.argv[0]} {args[0]} failed ({r.returncode}): "
                          f"{r.stderr.decode(errors='replace').strip()[:300]}")
        return r.stdout

    def list(self, directory):
        files = json.loads(self._run("list", directory) or b"{}")
        if isinstance(files, list):
            files = {f["name"]: f for f in files}
        out = {}
        for name, f in files.items():
            m = f.get("modified_at")
            out[name] = {"name": name, "modified_at": _iso(m) if isinstance(m, int | float) else m}
        return out

    def get(self, path):
        return self._run("get", path)
