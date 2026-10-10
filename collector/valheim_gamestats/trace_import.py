"""Combat facts from a recorded trace (plugin [Debug] Trace: BepInEx/gamestats/trace/<UTC day>.jsonl) into the events,
for runs of a plugin that didn't store facts yet: combat.py then recomputes those runs too.

    python3 -m valheim_gamestats.trace_import <data>/<server> <trace.jsonl> [--write]

Without --write it only says what it would do. Per server start in the trace (its clock starts again), the plugin run it
belongs to is found by the plugin's start events; the trace's clock (seconds since the game started) is put on the
store's by the players' deaths, which both have — else at OFFSET after the run's start event (the median of the deaths
seen: 31–34 s on 2026-10-10). A run that has facts in the store already is left alone. Imported facts are events "cf"
like the plugin's (source "trace"), so importing the same file twice adds nothing. It runs next to the collector (in its
container, under its memory limit): the trace is read again per server start rather than held whole (a busy day's is
150,000 lines), and of the store it reads only the start events, the deaths and where facts are.

facts() is also what tools/combat_fixture.py makes test fixtures with (with invented names).

Stdlib only.
"""
import datetime
import json
import os
import statistics
import sys

from . import events

PART = 2500       # a meta part's size, as the plugin splits it (CombatTrace.cs)
OFFSET = 31.0     # the trace's clock zero after the run's start event, when no death says better
MATCH = 120.0     # a death in the trace and in the store: this close at the default offset


class Same:
    """Names, clients and object ids as they are (tools/combat_fixture.py has one that invents them)."""

    def name(self, n):
        return n

    def client(self, c):
        return int(c or 0)

    def uid(self, u):
        return u


# what CombatCore made of it: never facts, and no time to fill in a line's that has none (the trace writes "k" first)
SKIP = '{"k":"out"'


def read(path):
    """A trace file's lines, without the results; a tick only as its time."""
    with open(path) as f:
        for line in f:
            if not line.strip() or line.startswith(SKIP):
                continue
            x = json.loads(line)
            yield {"k": "tick", "t": x["t"]} if x.get("k") == "tick" else x


def numbered(lines):
    """(server start, line): the next one where the trace's clock starts again."""
    n, prev = 0, None
    for x in lines:
        if x.get("k") == "tick":
            if prev is not None and x["t"] < prev - 5:
                n += 1
            prev = x["t"]
        yield n, x


class Server:
    """One server start in a trace: what plan() needs of it, and its lines again whenever iterated (from source(), a
    fresh pass over the whole trace — a file read again rather than held)."""

    def __init__(self, source, n):
        self.source, self.n = source, n
        self.length, self.deaths, self.meta = 0.0, [], False

    def __iter__(self):
        for n, x in numbered(self.source()):
            if n > self.n:
                return
            if n == self.n:
                yield x


def scan(source):
    """The server starts in a trace (source(): its lines, as often as asked): how long each ran by its clock, which
    players died when by it, whether it has the prefabs' facts."""
    out, last = [], 0.0
    for n, x in numbered(source()):
        if n == len(out):
            out.append(Server(source, n))
            last = 0.0
        server = out[n]
        last = x.get("t", last)
        server.length = max(server.length, float(x.get("t", 0.0)))
        if x["k"] == "meta":
            server.meta = True
        elif x["k"] == "player" and x["a"] <= 0 < x["b"]:
            server.deaths.append((x["p"], last))
    return out


def facts(lines, ids=None):
    """One server start's trace lines → the facts the plugin stores for them (with the trace's own clock in "t"): what
    the trace has and the facts don't (ticks, results, food lines, other characters' attacks, hits on players, items
    that aren't loot) is left out; what older traces lack (an attack's animation, a creature's owner, a player's
    client, a kill note's sender id, a player line's time) is filled in from the rest, as tests/plugin/Replay.cs does.
    lines: a list, or anything else that can be gone through twice (a Server: the file read again)."""
    ids = ids or Same()
    meta, clients, owners = None, {}, {}
    for x in lines:
        if x["k"] == "meta" and meta is None:
            meta = x
        # names and clients as the trace knows them: deletions name their client ("from") and number it ("own")
        if x["k"] == "destroy" and x.get("from") and x.get("own"):
            clients[x["from"]] = x["own"]
        if x["k"] in ("hit", "destroy") and x.get("own") and x.get("u"):
            owners[x["u"]] = x["own"]
        elif x["k"] == "owner" and x.get("now"):
            owners[x["u"]] = x["now"]
    loot = {i for t in (meta or {}).get("drops", {}).values() for i in t}
    name, cid, uid = ids.name, ids.client, ids.uid

    def who(w):
        return "player:" + name(w[7:]) if w and w.startswith("player:") else w

    def players(lst):
        return [dict(p, n=name(p["n"]), c=cid(p.get("c") or clients.get(p["n"]))) for p in lst or []]

    for n in clients:  # every known client first, so ids map the same everywhere
        cid(clients[n])
    out = []
    if meta:
        out.append({"k": "meta0", "v": 2})
        for key in ("noragdoll", "ragdolls", "cost", "drops", "timed", "reach", "names", "dots", "weapons"):
            if key not in meta:
                continue
            value = meta[key]
            if key == "cost" and isinstance(value, list):  # the first trace builds: [{"w","a","f","p"}]
                value = {c["w"] + "/" + c["a"]: {"f": c["f"], "p": c["p"]} for c in value}
            entries = list(value) if isinstance(value, list) else list(value.items())
            part, size = [], 0
            for entry in entries + [None]:
                text = json.dumps(entry)
                if entry is None or (size + len(text) > PART and part):
                    out.append({"k": "meta", "s": key, "d": part if isinstance(value, list) else dict(part)})
                    part, size = [], 0
                if entry is not None:
                    part.append(entry)
                    size += len(text)
    last = 0.0  # the first trace builds' player lines have no time: the latest one seen
    for x, nxt in ahead(lines):
        k = x["k"]
        last = x.get("t", last)
        if k == "attack":
            an = x.get("an") or (nxt.get("tr") if nxt.get("k") == "trig" and nxt.get("m") == "player:" + x["p"]
                                 and nxt.get("t") == x["t"] else None)
            out.append({"k": "attack", "t": x["t"], "p": name(x["p"]), "w": x["w"], "an": an})
        elif k == "player":
            if not (x["ma"] < x["mb"] - 0.01 and abs(x["a"] - x["ma"]) < 0.01):
                out.append(dict(x, t=x.get("t", last), p=name(x["p"])))
        elif k == "health":
            out.append(dict(x, u=uid(x["u"]), l=players(x["l"]), own=cid(x.get("own") or owners.get(x["u"]))))
        elif k == "trig":
            if x.get("tamed") and x.get("fol"):
                out.append(dict(x, u=uid(x["u"]), fol=name(x["fol"]), own=cid(x.get("own"))))
        elif k == "hit":
            if not str(x.get("m", "")).startswith("player:"):
                out.append(dict(x, u=uid(x["u"]), own=cid(x.get("own")), att=uid(x.get("att")), am=who(x.get("am")),
                                **{"from": name(x.get("from"))}))
        elif k == "killnote":
            out.append(dict(x, to=name(x["to"]), fromid=cid(x.get("fromid") or clients.get(x["from"])),
                            **{"from": name(x["from"])}))
        elif k == "destroy":
            out.append(dict(x, u=uid(x["u"]), l=players(x["l"]), ps=players(x["ps"]), own=cid(x.get("own")),
                            fol=name(x.get("fol")), **{"from": name(x.get("from"))}))
        elif k == "ragdoll":
            out.append(dict(x, u=uid(x["u"])))
        elif k == "drop":
            head = int(x["u"].split(":")[0]) if ":" in x["u"] else 0
            if x["i"] in loot and head in clients.values():
                out.append(dict(x, u=uid(x["u"]), own=cid(x.get("own"))))
    return [{"e": "cf", **x} for x in out]


def ahead(lines):
    """Each line with the next ({} after the last)."""
    cur = None
    for x in lines:
        if cur is not None:
            yield cur, x
        cur = x
    if cur is not None:
        yield cur, {}


def plan(servers, starts, deaths, day):
    """Per server start in the trace (scan()): [the run's start event time, the trace clock's zero on the store's, how it
    was found, the Server]. starts: the plugin's start events (wall clock), deaths: (player, wall clock), day: the
    trace file's UTC day (a datetime.date). The server starts are the runs in a row that fit them best: every one but
    the last lasts its run less the clock's offset (the file's first may have begun the day before)."""
    begin = datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.UTC).timestamp()
    runs = [s for s in starts if s < begin][-1:] + [s for s in starts if begin <= s < begin + 86400]
    ends = {s: e for s, e in zip(starts, starts[1:], strict=False)}
    best = None
    for k in range(len(runs) - len(servers) + 1):
        cost = sum(abs(ends[runs[k + i]] - runs[k + i] - OFFSET - servers[i].length) for i in range(len(servers) - 1))
        if best is None or cost < best[0]:
            best = (cost, k)
    if best is None or best[0] > MATCH * max(1, len(servers) - 1):
        raise ValueError(f"{len(servers)} server starts in the trace don't fit the {len(runs)} plugin runs of that day")
    out, guesses = [], []
    for server, start in zip(servers, runs[best[1]:], strict=False):
        found = []
        for player, t in server.deaths:
            near = [w for p, w in deaths if p == player and abs(w - (start + OFFSET + t)) <= MATCH]
            if near:
                found.append(min(near, key=lambda w: abs(w - (start + OFFSET + t))) - t)
        if found:
            zero = statistics.median(found)
            guesses.append(zero - start)
            out.append([start, zero, f"{len(found)} deaths", server])
        else:
            out.append([start, None, None, server])
    offset = statistics.median(guesses) if guesses else OFFSET
    for row in out:
        if row[1] is None:
            row[1], row[2] = row[0] + offset, f"no death, {offset:.1f} s after the start"
    return out


def run(sdir, path, write=False):
    day = datetime.date.fromisoformat(os.path.basename(path)[:10])
    servers = scan(lambda: read(path))
    db = events.open_db(sdir)
    try:
        starts = sorted(t for (t,) in db.execute("SELECT t FROM events WHERE e = 'plugin'"))
        deaths = [(json.loads(body).get("p"), t) for t, body in db.execute("SELECT t, body FROM events WHERE e = 'death'")]
        base = (day - datetime.date(1970, 1, 1)).days * 10_000_000
        added = 0
        for start, zero, how, server in plan(servers, starts, deaths, day):
            end = next((s for s in starts if s > start), float("inf"))
            when = datetime.datetime.fromtimestamp(start, datetime.UTC).strftime("%H:%M:%S")
            if db.execute("SELECT 1 FROM events WHERE e = 'cf' AND t >= ? AND t < ? LIMIT 1", (start, end)).fetchone():
                print(f"run {when}: has facts in the store already, left alone")
                continue
            if not server.meta:
                print(f"run {when}: its trace has no prefab facts (an older build), left alone")
                continue
            fs = facts(server)
            new = 0
            for k, f in enumerate(fs):
                t = zero + float(f["t"]) if "t" in f else zero
                if write and events.add(db, "trace", base + server.n * 1_000_000 + k, dict(f, t=min(t, end - 0.001))):
                    new += 1
            added += new
            print(f"run {when}: clock zero {zero - start:+.1f} s after the start ({how}), {len(fs)} facts"
                  + (f", {new} new" if write else ""))
        if write:
            db.commit()
        return added
    finally:
        db.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--write"]
    if len(args) != 2:
        sys.exit(__doc__)
    run(args[0], args[1], write="--write" in sys.argv)
