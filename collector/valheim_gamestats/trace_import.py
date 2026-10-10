"""Combat facts from a recorded trace (plugin [Debug] Trace: BepInEx/gamestats/trace/<UTC day>.jsonl) into the events,
for runs of a plugin that didn't store facts yet: combat.py then recomputes those runs too.

    python3 -m valheim_gamestats.trace_import <data>/<server> <trace.jsonl> [--write]

Without --write it only says what it would do. Per server start in the trace (its clock starts again), the plugin run it
belongs to is found by the plugin's start events; the trace's clock (seconds since the game started) is put on the
store's by the players' deaths, which both have — else at OFFSET after the run's start event (the median of the deaths
seen: 31–34 s on 2026-10-10). A run that has facts in the store already is left alone. Imported facts are events "cf"
like the plugin's (source "trace"), so importing the same file twice adds nothing.

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


def epochs(lines):
    """The trace's lines per server start: the clock starting again."""
    out, prev = [[]], None
    for x in lines:
        t = x.get("t")
        if x.get("k") == "tick" and prev is not None and t < prev - 5:
            out.append([])
        if x.get("k") == "tick":
            prev = t
        out[-1].append(x)
    return [e for e in out if e]


def facts(lines, ids=None):
    """One server start's trace lines → the facts the plugin stores for them (with the trace's own clock in "t"): what
    the trace has and the facts don't (ticks, results, food lines, other characters' attacks, hits on players, items
    that aren't loot) is left out; what older traces lack (an attack's animation, a creature's owner, a player's
    client, a kill note's sender id, a player line's time) is filled in from the rest, as tests/plugin/Replay.cs does."""
    ids = ids or Same()
    meta = next((x for x in lines if x["k"] == "meta"), None)
    # names and clients as the trace knows them: deletions name their client ("from") and number it ("own")
    clients = {x["from"]: x["own"] for x in lines if x["k"] == "destroy" and x.get("from") and x.get("own")}
    owners = {}
    for x in lines:
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
    for i, x in enumerate(lines):
        k = x["k"]
        last = x.get("t", last)
        if k == "attack":
            nxt = lines[i + 1] if i + 1 < len(lines) else {}
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


def plan(lines, starts, deaths, day):
    """Per server start in the trace: [the run's start event time, the trace clock's zero on the store's, how it was
    found, its lines]. starts: the plugin's start events (wall clock), deaths: (player, wall clock), day: the trace
    file's UTC day (a datetime.date). The server starts are the runs in a row that fit them best: every one but the
    last lasts its run less the clock's offset (the file's first may have begun the day before)."""
    eps = epochs(lines)
    begin = datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.UTC).timestamp()
    runs = [s for s in starts if s < begin][-1:] + [s for s in starts if begin <= s < begin + 86400]
    ends = {s: e for s, e in zip(starts, starts[1:], strict=False)}
    length = [max((x["t"] for x in ep if "t" in x), default=0.0) for ep in eps]
    best = None
    for k in range(len(runs) - len(eps) + 1):
        cost = sum(abs(ends[runs[k + i]] - runs[k + i] - OFFSET - length[i]) for i in range(len(eps) - 1))
        if best is None or cost < best[0]:
            best = (cost, k)
    if best is None or best[0] > MATCH * max(1, len(eps) - 1):
        raise ValueError(f"{len(eps)} server starts in the trace don't fit the {len(runs)} plugin runs of that day")
    out, guesses = [], []
    for ep, start in zip(eps, runs[best[1]:], strict=False):
        found, last = [], 0.0
        for x in ep:
            last = x.get("t", last)
            if x["k"] == "player" and x["a"] <= 0 < x["b"]:
                near = [w for p, w in deaths if p == x["p"] and abs(w - (start + OFFSET + last)) <= MATCH]
                if near:
                    found.append(min(near, key=lambda w: abs(w - (start + OFFSET + last))) - last)
        if found:
            zero = statistics.median(found)
            guesses.append(zero - start)
            out.append([start, zero, f"{len(found)} deaths", ep])
        else:
            out.append([start, None, None, ep])
    offset = statistics.median(guesses) if guesses else OFFSET
    for row in out:
        if row[1] is None:
            row[1], row[2] = row[0] + offset, f"no death, {offset:.1f} s after the start"
    return out


def run(sdir, path, write=False):
    day = datetime.date.fromisoformat(os.path.basename(path)[:10])
    with open(path) as f:
        lines = [json.loads(x) for x in f if x.strip()]
    db = events.open_db(sdir)
    try:
        evs = events.load(db)
        starts = sorted(ev["t"] for ev in evs if ev.get("e") == "plugin")
        deaths = [(ev.get("p"), ev["t"]) for ev in evs if ev.get("e") == "death"]
        have = [ev["t"] for ev in evs if ev.get("e") == "cf"]
        added = 0
        rows = plan(lines, starts, deaths, day)
        base = (day - datetime.date(1970, 1, 1)).days * 10_000_000
        n = 0
        for start, zero, how, ep in rows:
            end = next((s for s in starts if s > start), float("inf"))
            when = datetime.datetime.fromtimestamp(start, datetime.UTC).strftime("%H:%M:%S")
            fs = facts(ep)
            if any(start <= t < end for t in have):
                print(f"run {when}: has facts in the store already, left alone")
                n += len(ep)
                continue
            if not any(f["k"] == "meta0" for f in fs):
                print(f"run {when}: its trace has no prefab facts (an older build), left alone")
                n += len(ep)
                continue
            new = 0
            for k, f in enumerate(fs):
                t = zero + float(f["t"]) if "t" in f else zero
                if write and events.add(db, "trace", base + n + k, dict(f, t=min(t, end - 0.001))):
                    new += 1
            n += len(ep)
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
