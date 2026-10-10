"""A recorded combat trace (plugin [Debug] Trace, one session's slice) → the combat facts the plugin stores for it
(events "cf", as plugin/CombatTrace.cs writes them), with invented player names and client ids: a fixture for
tests/combat/, where the plugin's rules (tests/plugin, C#) and the collector's (combat.py) must agree on it.

    python3 tools/combat_fixture.py <trace.jsonl> <out.jsonl.gz> [first line] [last line]

The conversion is the collector's (valheim_gamestats.trace_import.facts), with the trace's own clock in "t".

Stdlib only.
"""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "collector"))
from valheim_gamestats.trace_import import facts  # noqa: E402

NAMES = ["Ragnar", "Astrid", "Bjorn", "Sigrid", "Leif", "Freya", "Ulf", "Ingrid"]


class Invented:
    """Player names and client ids made up in the order they come."""

    def __init__(self):
        self.names, self.ids = {}, {}

    def name(self, n):
        if n is None:
            return None
        if n not in self.names:
            self.names[n] = NAMES[len(self.names)] if len(self.names) < len(NAMES) else f"Player{len(self.names) + 1}"
        return self.names[n]

    def client(self, c):
        c = int(c or 0)
        if c == 0:
            return 0
        if c not in self.ids:
            self.ids[c] = 1001 + len(self.ids)
        return self.ids[c]

    def uid(self, u):
        if not u or ":" not in u:
            return u
        head, tail = u.split(":", 1)
        return f"{self.client(head) if abs(int(head)) > 1000 else head}:{tail}"  # a client's own objects; 1: the world's


def main(src, dst, first=0, last=None):
    with open(src) as f:
        lines = [json.loads(x) for x in f][int(first):None if last is None else int(last)]
    ids = Invented()
    out = facts(lines, ids)
    with gzip.open(dst, "wt") as f:
        for x in out:
            f.write(json.dumps(x, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"{dst}: {len(out)} facts, players {sorted(ids.names.values())}", file=sys.stderr)


if __name__ == "__main__":
    main(*sys.argv[1:])
