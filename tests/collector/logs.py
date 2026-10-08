"""Builds a game server log the way the collector archived it from Loki: [(ts_ns, line)], in the server's own
formats — and, through events.from_lines (what the archive import does), the events the collector builds from.

    log = Log()
    log.restart(0).plugin(5, "1.15.0").spawn(60, "Ragnar", 1001)
    log.g(120, e="kill", p="Ragnar", i="Greyling", n=1)
    Valheim.rebuild(log.events(), log.t0 + 3600)

Times are seconds after T0; the rows carry absolute nanoseconds like Loki's.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "collector"))

T0 = 1_790_000_000  # 2026-09-21 — any fixed instant
NS = 1_000_000_000


def read_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f)


class Log:
    def __init__(self, t0=T0):
        self.t0 = t0
        self.rows = []

    def at(self, t):
        return self.t0 + t

    def events(self):
        from valheim_gamestats import events
        return events.from_lines(sorted(self.rows))

    def raw(self, t, text):
        ts = self.at(t)
        self.rows.append((int(ts * NS) + len(self.rows), time.strftime("%m/%d/%Y %H:%M:%S", time.gmtime(ts)) + ": " + text))
        return self

    def restart(self, t, version="l-1.0.16"):
        self.raw(t - 50, f"Valheim version: {version} (network version 40)")  # the server logs it ~1 min before
        return self.raw(t, 'New session server "Test" that has join code , now 0 player(s)')

    def connect(self, t, steam_id):
        return self.raw(t, f"PlayFab socket with remote ID playfab/0 received local Platform ID Steam_{steam_id}")

    def spawn(self, t, name, uid, n=1):
        return self.raw(t, f"Got character ZDOID from {name} : {uid}:{n}")

    def death(self, t, name):
        return self.raw(t, f"Got character ZDOID from {name} : 0:0")

    def logout(self, t, uid):
        return self.raw(t, f"Destroying abandoned non persistent zdo {uid}:1 owner {uid}")

    def players(self, t, n, zdos=1000):
        return self.raw(t, f" Connections {n} ZDOS:{zdos}  sent:0 recv:0")

    def raid(self, t, name="army_eikthyr"):
        return self.raw(t, f"Random event set:{name}")

    def location(self, t, name, x, y):
        return self.raw(t, f"Placed location {name} in zone {x},{y}  duration 1.0 ms")

    def g(self, t, **line):
        """A plugin line: [Gamestats] {"e": …, "p": …, …}"""
        return self.raw(t, "[Gamestats] " + json.dumps(line, ensure_ascii=False, separators=(",", ":")))

    def plugin(self, t, version):
        return self.g(t, e="plugin", p="", i=version, n=1)

    def zone(self, t, x, y, by):
        return self.g(t, e="zone", p="", i=f"{x},{y}", n=1, by=by)

    def warn(self, t, area, msg):
        return self.raw(t, f"[Gamestats] {area}: {msg}")

    def minutes(self, a, b, name, **line):
        """The plugin's per-minute lines for one player from a to b (seconds), e.g. a peak every minute."""
        for t in range(a, b, 60):
            self.g(t, p=name, **line)
        return self
