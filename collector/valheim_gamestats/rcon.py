"""Player positions for the gamestats collector, over RCON.

Vanilla Valheim never logs or saves where players are: Player objects are not
persisted, and the position only lives in the server's memory. The game server
runs the ValheimRcon BepInEx plugin, whose `players` command prints one line
per connected peer:

  <name> Steam ID:<id> Position: (x y z) Zone: (zx zy) [Player ID:… HP:…] Public position: True|False …

Only players who set "visible to other players" on their in-game map
(`Public position: True`) are recorded. A player seen online with it off has
their stored position dropped, so turning it off also removes them from the
page. Steam IDs are never kept.

The same poll reads the world clock (`time`) and the global keys
(`globalKeys`: bosses, milestones, world settings), so the page and the
Discord news learn about a boss kill within a minute instead of after the next
world save. A key that shows up between two polls gets that one-minute window
as its time.

`equipment` comes from our own companion plugin (../plugin, ValheimGamestats):
the visible gear of every connected player — item per slot, quality where the
game syncs it. Without the plugin the reply is not JSON and is ignored.

The game never syncs the level of helmet, chest, legs, utility or trinket.
`tombstones` (same plugin) lists the levelled gear in every tombstone; a
tombstone is the dead player's whole inventory, so the newest one per player
gives "level at last death" for the items they still wear.

<server-id>/positions.json:
  {"ok": last successful poll, "online": [names sharing their position], "connected": [every name online],
   "players": {name: {"x", "z", "t"}}}
  "connected" is ValheimRcon's own view of who is online: health.py checks the plugin's sessions against it.
<server-id>/world_live.json:
  {"t": poll time, "time": world clock (s), "keys": [...], "first": {key: [from, to]}}
<server-id>/equipment.json:
  {"ok": last poll with the plugin, "online": [names], "players": {name: {"t", "slots": {slot: {"item", "q"?, "v"?}},
   "look"?: {"m": body model, "skin"/"hair": [r, g, b] tint, "h"/"b": hair/beard item}}},
   "usage": {name: {slot: {item: {"f": first worn, "l": last worn, "s": seconds worn, "q"?: best level seen}}}}}
  usage is the gear history: small aggregates instead of every swap (hands change every few seconds).
<server-id>/tombstones.json:
  {"seen": {tombstone id: death (wall clock)}, "owners": {tombstone id: name}, "levels": {name: {prefab: {"q", "t": death}}}}
  A tombstone is the game's own record of a death: health.py checks the plugin's deaths against new ones.
<server-id>/portals.json (`portals`, plugin 1.14.0+):
  {"t": poll time, "list": [[tag, x, z, partner index or -1]]} — which portal the game has linked to which, now;
  the world save only tells which share a tag.

Stdlib only.
"""
import json
import os
import re
import socket
import struct
import time

AUTH, EXEC = 3, 2
LINE = re.compile(r"^(?P<name>.*?) Steam ID:\S* Position: \((?P<x>\S+) (?P<y>\S+) (?P<z>\S+)\)"
                  r".*? Public position: (?P<public>True|False)")


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


def _packet(rid, kind, body):
    b = struct.pack("<ii", rid, kind) + body.encode() + b"\0\0"
    return struct.pack("<i", len(b)) + b


def _recv(s, n):
    d = b""
    while len(d) < n:
        chunk = s.recv(n - len(d))
        if not chunk:
            raise ConnectionError("rcon: connection closed")
        d += chunk
    return d


def _read(s):
    n = struct.unpack("<i", _recv(s, 4))[0]
    d = _recv(s, n)
    rid, kind = struct.unpack("<ii", d[:8])
    return rid, kind, d[8:-2].decode("utf-8", "replace")


def command(host, port, password, *cmds, timeout=10):
    """One Source-RCON session: authenticate, run each cmd, return their outputs."""
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(_packet(1, AUTH, password))
        rid, _, _ = _read(s)
        if rid == -1:
            raise PermissionError("rcon: authentication failed")
        out = []
        for i, cmd in enumerate(cmds, 2):
            s.sendall(_packet(i, EXEC, cmd))
            out.append(_read(s)[2])
        return out


def _num(v):
    return float(v.replace(",", "."))  # the plugin formats with the server's culture


def parse_players(out):
    """`players` output -> [{"name", "x", "z", "public"}] (y, the height, is not needed)."""
    lines = out.splitlines()
    if not lines or not lines[0].startswith("Online "):
        raise ValueError(f"rcon: unexpected players output: {out[:80]!r}")
    players = []
    for line in lines[1:]:
        if not line.strip():
            continue
        m = LINE.match(line)
        if not m:
            raise ValueError(f"rcon: unexpected player line: {line[:120]!r}")
        if not m["name"].strip():
            continue  # connected, character not spawned yet
        players.append({"name": m["name"].strip(), "x": _num(m["x"]), "z": _num(m["z"]),
                        "public": m["public"] == "True"})
    return players


def parse_keys(out):
    """`globalKeys` output -> sorted keys, spelled as in the world save ("activebosses 0")."""
    lines = out.splitlines()
    if not lines or lines[0].strip() != "Global Keys:":
        raise ValueError(f"rcon: unexpected globalKeys output: {out[:80]!r}")
    return sorted({re.sub(r"\s*:.*$", "", ln).strip() for ln in lines[1:] if ln.strip()})


def parse_time(out):
    """`time` output -> world clock in seconds."""
    m = re.match(r"Current server time: ([\d.,]+) sec", out)
    if not m:
        raise ValueError(f"rcon: unexpected time output: {out[:80]!r}")
    return _num(m.group(1))


def _load(path, default):
    if os.path.exists(path):
        with open(path) as f:
            default.update(json.load(f))
    return default


def _save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def update(server, sdir):
    """Poll players, global keys and the world clock once; merge into the state files."""
    rcfg = server["rcon"]
    password = os.environ.get(rcfg.get("password_env", ""), "")
    if not password:
        return
    out_players, out_keys, out_time, out_equip, out_tombs, out_portals = command(
        rcfg["host"], rcfg.get("port", 25575), password, "players", "globalKeys", "time", "equipment", "tombstones", "portals")
    now = round(time.time())

    if out_portals.startswith("["):  # plugin 1.14.0+: the game's own portal pairing, as it is now
        _save(os.path.join(sdir, "portals.json"), {"t": now, "list": json.loads(out_portals)})

    if out_tombs.startswith("["):
        path = os.path.join(sdir, "tombstones.json")
        fresh = not os.path.exists(path)
        tombs = _load(path, {"seen": {}, "owners": {}, "levels": {}})
        tombs.setdefault("owners", {})
        clock = parse_time(out_time)
        for tb in json.loads(out_tombs):
            if tb["id"] not in tombs["seen"]:
                # Polled every minute, so first sight is the death. Tombstones that already lay
                # around on the very first poll get it from the world clock (which only runs while
                # someone is online, so older deaths come out somewhat too recent).
                tombs["seen"][tb["id"]] = round(now - max(0, clock - tb["died"])) if fresh else now
            tombs["owners"][tb["id"]] = tb["owner"]
            died = tombs["seen"][tb["id"]]
            mine = tombs["levels"].setdefault(tb["owner"], {})
            best = {}
            for it in tb["items"]:  # several copies: they most likely wear the best one
                best[it["item"]] = max(best.get(it["item"], 0), it["q"])
            for item, q in best.items():
                if died >= mine.get(item, {}).get("t", 0):
                    mine[item] = {"q": q, "t": died}
        _save(path, tombs)

    if out_equip.startswith("["):
        path = os.path.join(sdir, "equipment.json")
        equip = _load(path, {"ok": 0, "online": [], "players": {}})
        seen = json.loads(out_equip)
        # time since the last poll counts as worn; after an outage only one poll's worth
        dt = min(now - equip["ok"], 120) if equip["ok"] else 60
        usage = equip.setdefault("usage", {})
        for p in seen:
            # "look" (plugin 1.9.0+): body model, skin/hair colour, hair/beard — kept from before when a reply lacks it
            look = p.get("look") or equip["players"].get(p["name"], {}).get("look")
            equip["players"][p["name"]] = {"t": now, "slots": p["slots"], **({"look": look} if look else {})}
            for slot, s in p["slots"].items():
                u = usage.setdefault(p["name"], {}).setdefault(slot, {}).setdefault(s["item"], {"f": now, "l": now, "s": 0})
                u["l"], u["s"] = now, u["s"] + dt
                if s.get("q"):
                    u["q"] = max(u.get("q", 0), s["q"])
        equip.update(ok=now, online=sorted(p["name"] for p in seen))
        _save(path, equip)

    path = os.path.join(sdir, "world_live.json")
    world = _load(path, {"t": 0, "keys": None, "first": {}})
    keys = parse_keys(out_keys)
    if world["keys"] is not None:  # the first poll only records what is already there
        for k in set(keys) - set(world["keys"]):
            world["first"].setdefault(k, [world["t"], now])
    world.update(t=now, time=round(parse_time(out_time), 1), keys=keys)
    _save(path, world)

    path = os.path.join(sdir, "positions.json")
    state = _load(path, {"ok": 0, "online": [], "players": {}})
    players = parse_players(out_players)
    for p in players:
        if p["public"]:
            state["players"][p["name"]] = {"x": round(p["x"]), "z": round(p["z"]), "t": now}
        else:
            state["players"].pop(p["name"], None)
    state["ok"] = now
    state["online"] = sorted(p["name"] for p in players if p["public"])
    state["connected"] = sorted(p["name"] for p in players)
    _save(path, state)


def portals(sdir, now, interval):
    """The "portals_live" block of data.json: [[tag, x, z, partner index or -1]] — positions at their 64 m zone,
    like everything players build — or None when the plugin hasn't answered for a while (the world save is used then)."""
    live = _load(os.path.join(sdir, "portals.json"), {})
    if not live.get("list") or now - live.get("t", 0) > 3 * interval:
        return None
    snap = lambda v: int((v + 32) // 64 * 64)
    return {"t": live["t"], "list": [[tag, snap(x), snap(z), partner] for tag, x, z, partner in live["list"]]}


def equipment(sdir, now, interval):
    """The "equipment" block of data.json: last-seen gear per player, or None without the plugin."""
    path = os.path.join(sdir, "equipment.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        equip = json.load(f)
    online = set(equip.get("online", [])) if now - equip.get("ok", 0) <= 3 * interval else set()
    tpath = os.path.join(sdir, "tombstones.json")
    levels = _load(tpath, {}).get("levels", {})
    out = {}
    for n, v in sorted(equip.get("players", {}).items()):
        slots = {}
        for slot, s in v["slots"].items():
            last = levels.get(n, {}).get(s["item"])
            # "lq"/"lt": level at their last death, for slots whose level the game doesn't sync
            slots[slot] = {**s, "lq": last["q"], "lt": last["t"]} if last and "q" not in s else s
        out[n] = {**v, "slots": slots, "online": n in online, "usage": equip.get("usage", {}).get(n, {})}
    return out


def live_world(sdir, now, interval):
    """{"t", "time", "keys", "first"} from the last poll, or None once polls have stopped."""
    path = os.path.join(sdir, "world_live.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        world = json.load(f)
    return world if world.get("keys") is not None and now - world["t"] <= 3 * interval else None


def public(sdir, now, interval):
    """The "positions" block of data.json, or None before the first poll.
    Players count as live only while polls keep succeeding."""
    path = os.path.join(sdir, "positions.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        state = json.load(f)
    live = now - state.get("ok", 0) <= 3 * interval
    online = set(state.get("online", [])) if live else set()
    return {
        "ok": state.get("ok", 0),
        "live": live,
        "players": [{"p": n, "x": v["x"], "z": v["z"], "t": v["t"], "online": n in online}
                    for n, v in sorted(state.get("players", {}).items())],
    }
