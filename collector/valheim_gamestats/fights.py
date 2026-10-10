"""Boss fights for data.json, from the ValheimGamestats plugin's combat lines.

The plugin logs per minute and player how much damage went to which creature
(`dmg`, per weapon `dw`) and who got a kill (`kill`, `kw`). A fight is a run of
those lines on one boss: it ends when the boss dies (every part of it, see
GROUPS / FINAL) or after GAP without damage — then the players gave up, and
the boss heals back to full within the hour (BaseAI regenerates every monster
by its max health per hour). Per fight: when, how long, outcome, damage per
player and weapon (and effective damage, "ed"/"edmg", since plugin 1.22.0),
kills, and the deaths and damage taken of the players in it (those are all
sources, not only the boss).

Before plugin 1.5.0 a health drop was split evenly over everyone who had ever
hit the boss; from 1.5.0 by who attacked. The plugin logs its version on start
(event "plugin"), so a fight knows which it was ("exact").

Stdlib only.
"""
GAP = 15 * 60
SAME_FLUSH = 30  # lines of one per-minute flush differ by microseconds; the next flush is a minute later
# Bosses fought as one: Kall's phases are separate creatures, Zil & Thungr come together.
GROUPS = {"FrozenKing_p2": "FrozenKing", "FrozenKing_p3": "FrozenKing",
          "GoblinShaman_Hildir": "HildirBros", "GoblinBruteBros": "HildirBros"}
FINAL = {"FrozenKing": {"FrozenKing_p3"}}  # dead once this part is; else once every part that took damage is
# Hildir's quest bosses: no boss flag in the game data, fought like one.
MINI = {"Skeleton_Hildir", "Fenring_Cultist_Hildir", "HildirBros"}


def build(evs, deaths, creatures, now):
    """evs: the events (events.py), oldest first; deaths: [{"p", "t"}]; creatures: creatures.json or {}."""
    bosses = {k for k, v in creatures.items() if v.get("boss")} | MINI
    exact_since = None
    events, taken = [], []
    for g in evs:
        t = g["t"]
        try:
            e, p, i, n = g["e"], g["p"], g["i"], int(g["n"])
        except (ValueError, KeyError, TypeError):
            continue
        if e == "plugin":
            if exact_since is None and tuple(int(x) for x in i.split(".")[:2]) >= (1, 5):
                exact_since = t
            continue
        if e == "taken":
            taken.append((t, p, n))
            continue
        if e not in ("dmg", "dw", "kill", "edmg"):
            continue
        weapon, _, mob = i.rpartition(">")
        part = mob.split("*")[0]
        key = GROUPS.get(part, part)
        if key in bosses:
            events.append((t, key, part, e, p, weapon, n))

    fights, open_ = [], {}
    for t, key, part, e, p, weapon, n in events:
        f = open_.get(key)
        if f and (t - f["e"] > GAP or (f["done"] is not None and t - f["done"] > SAME_FLUSH)):
            fights.append(open_.pop(key))
            f = None
        if f is None:
            f = open_[key] = {"boss": key, "s": t - 60, "e": t, "parts": set(), "dead": set(), "done": None,
                              "players": {}}
        f["e"] = max(f["e"], t)
        pl = f["players"].setdefault(p, {"d": 0, "w": {}, "k": 0, "ed": None})
        if e == "edmg":
            pl["ed"] = (pl["ed"] or 0) + n
        elif e == "dmg":
            pl["d"] += n
            f["parts"].add(part)
        elif e == "dw":
            pl["w"][weapon] = pl["w"].get(weapon, 0) + n
        elif e == "kill":
            pl["k"] = 1
            f["dead"].add(part)
        # dead once every part is — re-checked as parts join (Zil takes damage in the minute Thungr dies)
        if (FINAL.get(key) or f["parts"]) <= f["dead"]:
            f["done"] = f["done"] or t
        else:
            f["done"] = None
    fights.extend(open_.values())

    out = []
    for f in sorted(fights, key=lambda f: f["s"]):
        s, e = round(f["s"]), round(f["e"])
        who = set(f["players"])
        died = [[round(d["t"]), d["p"]] for d in deaths if d["p"] in who and s <= d["t"] <= e + 60]
        players = {}
        for p, v in f["players"].items():
            players[p] = {"d": v["d"], "w": v["w"], "k": v["k"],
                          "x": sum(1 for _, q in died if q == p),
                          "tk": sum(n for t, q, n in taken if q == p and s < t <= e)}
            if v["ed"] is not None:
                players[p]["ed"] = v["ed"]
        out.append({
            "id": f"{f['boss']}-{s}",
            "boss": f["boss"],
            "parts": sorted(f["parts"] | f["dead"]),
            "s": s,
            "e": e,
            "outcome": "killed" if f["done"] is not None else "ongoing" if now - f["e"] <= GAP else "retreat",
            "dmg": sum(v["d"] for v in players.values()),
            "players": players,
            "deaths": died,
            "exact": exact_since is not None and f["s"] >= exact_since,
        })
        if any("ed" in v for v in players.values()):  # effective damage, where the plugin recorded the players near
            out[-1]["edmg"] = sum(v.get("ed", 0) for v in players.values())  # the boss (1.22.0): see combat.scale
    return out
