"""Tamed creatures ("pets") for data.json.

valheim_world.snapshot() lists every tame in a save: its identity "k" (prefab +
BaseAI's spawntime, which survives saves and restarts), position, stars, health,
name, who named it and whom it follows. update() keeps a registry across saves
in <server-id>/pets.json: first and last save it was in, and the save it was
missing from first ("gone").

The ValheimGamestats plugin (1.6.0+) logs each death the moment it happens:
  [Gamestats] {"e":"petdeath","p":name,"i":prefab,"k":key,"x","z","hp","lv","by":[players],"near":creature,"nd":m}
Since 1.7.0 also its health history, one line per pet and minute with a change:
  [Gamestats] {"e":"pethp","k":key,"dmg","hits","heal","min","hp","max","by":{source: damage}}
(source: a player, "~creature" — the nearest one around, a guess — or "?").
public() joins all of it. A pet that left the saves without a logged death is young
that grew up ("grew"), or a death the plugin did not see ("gone": before 1.6.0,
or while it was down). "named by" is a platform id in the save; it is published
as the character name from accounts.json, or not at all.

Stdlib only.
"""
import json
import os

YOUNG = {"Wolf_cub", "Boar_piggy", "Lox_Calf", "Chicken", "Asksvin_hatchling"}  # Growup: replaced by the adult
HISTORY = 500  # minutes with a change kept per pet in data.json (totals cover all)


def _load(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def update(sdir, snap):
    """Merge one world snapshot into the registry."""
    path = os.path.join(sdir, "pets.json")
    reg = _load(path, {})
    t, seen = snap["t"], set()
    for p in snap.get("pets", []):
        old = reg.get(p["k"], {})
        reg[p["k"]] = {**{k: v for k, v in p.items() if k != "k"}, "first": old.get("first", t), "last": t}
        seen.add(p["k"])
    for k, e in reg.items():
        if k not in seen and "gone" not in e and e["last"] < t:
            e["gone"] = t
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(reg, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def public(sdir, evs):
    """The pets for data.json: registry + the plugin's deaths (evs: the events, oldest first)."""
    reg = _load(os.path.join(sdir, "pets.json"), {})
    accounts = _load(os.path.join(sdir, "accounts.json"), {})  # {steam id: [characters]}
    deaths, hist, renamed = {}, {}, {}  # renamed: the latest name a plugin line carried (renamed after the last save)
    for ev in evs:
        if ev.get("e") == "pethp" and ev.get("k"):
            if ev.get("p"):
                renamed[ev["k"]] = ev["p"]
            hist.setdefault(ev["k"], []).append([round(ev["t"]), ev.get("dmg", 0), ev.get("hits", 0), ev.get("heal", 0),
                                                 ev.get("min"), ev.get("hp"), ev.get("max"), ev.get("by") or {}])
        elif ev.get("e") == "petdeath" and ev.get("k"):
            if ev.get("p"):
                renamed[ev["k"]] = ev["p"]
            deaths[ev["k"]] = {"t": round(ev["t"]), "x": ev.get("x"), "z": ev.get("z"), "by": ev.get("by") or [],
                               **({"near": ev["near"], "nd": ev.get("nd")} if ev.get("near") else {}),
                               "_ev": ev}
    out = []
    for k, e in reg.items():
        p = {"k": k, **{f: v for f, v in e.items() if f != "by"}}
        sid = (e.get("by") or "").split("_", 1)[-1]
        if (names := accounts.get(sid)):
            p["by"] = names[0]
        if k in deaths:
            p["status"], p["death"] = "dead", {f: v for f, v in deaths[k].items() if f != "_ev"}
        elif "gone" in e:
            p["status"] = "grew" if e["s"] in YOUNG else "gone"
        else:
            p["status"] = "alive"
        out.append(p)
    # tamed and killed between two saves: only the death line knows it
    for k, d in deaths.items():
        if k not in reg:
            ev = d["_ev"]
            out.append({"k": k, "s": ev.get("i"), "lv": ev.get("lv", 0), "x": d["x"], "z": d["z"], "status": "dead",
                        **({"n": ev["p"]} if ev.get("p") else {}),
                        "death": {f: v for f, v in d.items() if f != "_ev"}})
    for p in out:
        if p["k"] in renamed and (p["status"] == "dead" or "n" not in p):  # a name given (or changed) since the last save
            p["n"] = renamed[p["k"]]
        if (h := hist.get(p["k"])):
            by = {}
            for *_, src in h:
                for s, n in src.items():
                    by[s] = by.get(s, 0) + n
            p["hurt"] = {"dmg": sum(x[1] for x in h), "hits": sum(x[2] for x in h), "heal": sum(x[3] for x in h),
                         "min": min((x[4] for x in h if x[4] is not None), default=None), "by": by}
            # [t, damage, hits, healed, lowest, health at the end, max, {source: damage}]
            p["hist"] = h[-HISTORY:]
    return sorted(out, key=lambda p: (p["status"] != "alive", p["s"] or "", p.get("n") or "", p["k"]))
