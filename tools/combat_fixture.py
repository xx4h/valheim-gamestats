"""A recorded combat trace (plugin [Debug] Trace, one session's slice) → the combat facts the plugin stores for it
(events "cf", as plugin/CombatTrace.cs writes them), with invented player names and client ids: a fixture for
tests/combat/, where the plugin's rules (tests/plugin, C#) and the collector's (combat.py) must agree on it.

    python3 tools/combat_fixture.py <trace.jsonl> <out.jsonl.gz> [first line] [last line]

What a trace has and the facts don't (ticks, results, food lines, other characters' attacks, hits on players, non-loot
items) is left out; what older traces lack and the facts carry (an attack's animation, a creature's owner, a player's
client, a kill note's sender id) is filled in from the rest of the trace, as tests/plugin/Replay.cs does.

Stdlib only.
"""
import gzip
import json
import sys

NAMES = ["Ragnar", "Astrid", "Bjorn", "Sigrid", "Leif", "Freya", "Ulf", "Ingrid"]
LATER = ("fire", "spirit", "poison")
PART = 2500


def main(src, dst, first=0, last=None):
    with open(src) as f:
        lines = [json.loads(x) for x in f][int(first):None if last is None else int(last)]
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
    names, ids = {}, {}

    def name(n):
        if n is None:
            return None
        if n not in names:
            names[n] = NAMES[len(names)] if len(names) < len(NAMES) else f"Player{len(names) + 1}"
        return names[n]

    def cid(c):
        c = int(c or 0)
        if c == 0:
            return 0
        if c not in ids:
            ids[c] = 1001 + len(ids)
        return ids[c]

    def uid(u):
        if not u or ":" not in u:
            return u
        head, tail = u.split(":", 1)
        return f"{cid(head) if abs(int(head)) > 1000 else head}:{tail}"  # a client's own objects; 1: the world's

    def who(w):
        return "player:" + name(w[7:]) if w and w.startswith("player:") else w

    def players(lst):
        return [dict(p, n=name(p["n"]), c=cid(p.get("c") or clients.get(p["n"]))) for p in lst or []]

    for n in clients:  # every known client first, so uids map the same everywhere
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
                            fol=name(x.get("fol")),
                            **{"from": name(x.get("from"))}))
        elif k == "ragdoll":
            out.append(dict(x, u=uid(x["u"])))
        elif k == "drop":
            head = int(x["u"].split(":")[0]) if ":" in x["u"] else 0
            if x["i"] in loot and head in clients.values():
                out.append(dict(x, u=uid(x["u"]), own=cid(x.get("own"))))
    with gzip.open(dst, "wt") as f:
        for x in out:
            f.write(json.dumps({"e": "cf", **x}, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"{dst}: {len(out)} facts, players {sorted(names.values())}", file=sys.stderr)


if __name__ == "__main__":
    main(*sys.argv[1:])
