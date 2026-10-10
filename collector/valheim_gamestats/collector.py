#!/usr/bin/env python3
"""gamestats collector.

Fetches what the game server's plugin recorded since the last run from its own
event store (RCON `gs_events`; the store's files through a file source while
the server is down) into SQLite on the PVC (see events.py), then rebuilds the
server's data from all of it ("data.json": one JSON document, served in pieces,
see chunks.py). Nothing comes from the game server's log.

Stdlib only — runs on a plain python:alpine image.

Servers with a "world" block additionally get an hourly snapshot of their
world save (see valheim_world.py), read through a file source (sources.py:
Pelican, a local directory or a script).
Servers with a "steam" block also get their players' Steam achievements
(see steam.py).
Every server needs an "rcon" block (ValheimRcon + the plugin): the events come
through it, and players' positions, gear and the world clock (see rcon.py).
Bosses get one entry per fight: who took part, damage, deaths (see fights.py).
Tamed creatures get one entry each, alive or dead (see pets.py).
Servers with a "notify" block post news (bosses, raids, medals, …) to a
Discord webhook after each rebuild (see notify.py).

Layout under DATA_DIR (default /data):
  <server-id>/events.db            every event (SQLite, see events.py): the plugin's store, and the old log archive
  <server-id>/archive.jsonl        [ts_ns, line] read from the server log before the plugin's store (imported once, kept)
  <server-id>/state.json           {"world_save": ...} — checkpoints
  <server-id>/world.json           latest world snapshot (aggregates only)
  <server-id>/world_history.jsonl  one small summary per processed save
  <server-id>/players.json         player id -> character name, learned from saves
  <server-id>/prefabs.json         prefab names from the game's asset manifest
  <server-id>/notify.json          what has been announced already
  <server-id>/accounts.json        Steam ID -> character names, from the plugin's logins (private)
  <server-id>/steam.json           Steam achievements per account (see steam.py; private)
  <server-id>/positions.json       last-seen position per player (see rcon.py)
  <server-id>/world_live.json      world clock + global keys from the last RCON poll
  <server-id>/equipment.json       last-seen visible gear per player (needs the ValheimGamestats plugin)
  <server-id>/tombstones.json      item levels from each player's newest tombstone (same plugin)
  steam/<app>/<hash>.jpg           achievement icons, served by nginx under /steam/
  site/<server-id>/index.json      what the web container serves: the files under c/ that make up the data (chunks.py)
  site/<server-id>/explored.png    the players' shared map (fog mask), from the world save
  site/<server-id>/terrain.png     the world's terrain, from the server plugin's sample (mapimg.py)
"""
import json
import os
import signal
import sys
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime

from . import chunks, combat, events, fights, health, mapimg, notify, pets, rcon, scoring, sources, steam, valheim_world

CONFIG = os.environ.get("CONFIG", "/config/config.json")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
NS = 1_000_000_000
CUSTODY = {"take", "put", "off", "on", "carry"}  # where gear went (plugin Custody.cs): kept per move, not summed
CUSTODY_KEEP = 20  # moves kept per copy of an item
FEATS = {"sprint": ("m", "s"), "closecall": ("hp", "max"), "fall": ("h", None)}  # plugin Vitals.cs: value and extra field


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


# --------------------------------------------------------------------------
# Valheim

class Valheim:
    # events that are bookkeeping, not something a player gathered: never summed into "gather"
    # cf: the plugin's combat facts — combat.py makes the results from them (before this), nothing is summed from them
    QUIET = {"plugin", "petdeath", "pethp", "warn", "login", "raidend", "lobby", "gone", "cf"}
    BOOT = {"plugin", "start"}  # a new boot: not a sign the old one was still up
    SAMPLE_EVERY = 600  # the server samples every minute; keep one per 10 min (and every change in players online)

    @classmethod
    def rebuild(cls, events, now):
        """Turn the events (events.py, oldest first) into sessions/deaths/raids/zones/….

        A login is a spawn with a connection (uid) not in an open session; respawns after death keep the uid. The
        session ends with the logout, the server stopping (plugin 1.17.0+) or starting anew — then at the last event
        before the new boot —, or a sample with nobody connected.
        """
        sessions, deaths, raids, days, restarts, samples = [], [], [], [], [], []
        zones = {}
        open_ = {}  # uid -> session dict
        version = None
        clock = None  # {t: wall time, time: world clock then}
        platforms, votes = [], Counter()  # pending (t, steam id); (steam id, character) -> joins
        gather = Counter()  # (hour, player, event, object) -> count
        custody = defaultdict(list)  # (item, crafter, quality) -> [[t, player, event, kind, x, z, n]]: where gear went
        visits, inside = [], {}  # dungeon visits [t, player, location, x, z, seconds or None]; player -> the open one
        peaks = {}   # (hour, player, key) -> highest value (plugin Vitals.cs: hp, st, eitr, y, v_*, hit)
        feats = []   # [t, player, kind, value, extra]: sprint (m, s), closecall (hp, max), fall (h, None)
        last_ts = None

        def close(sess, t, reason):
            sess["e"] = max(t, sess["s"])
            sess["end"] = reason
            sessions.append(sess)

        def online():
            return sorted({s["p"] for s in open_.values()})

        for g in events:
            t = g["t"]
            try:
                e = g["e"]
                if e in cls.QUIET:
                    if e == "login" and str(g.get("i", "")).startswith("Steam_"):  # the plugin knows the account itself
                        votes[(g["i"].split("_", 1)[1], g["p"])] += 1
                elif e == "spawn":
                    name, uid = g["p"], str(g["uid"])
                    if uid in open_:
                        open_[uid]["spawns"] += 1
                    else:
                        # Same character on a new uid without a logout in between: the old session is over.
                        for u, s in list(open_.items()):
                            if s["p"] == name:
                                close(open_.pop(u), t, "relog")
                        open_[uid] = {"p": name, "s": t, "deaths": 0, "spawns": 1}
                        # old archives: pair with the oldest connection still waiting for its character
                        platforms = [x for x in platforms if t - x[0] <= 600]
                        if platforms:
                            votes[(platforms.pop(0)[1], name)] += 1
                elif e == "death":
                    deaths.append({"p": g["p"], "t": round(t)})
                    for s in open_.values():
                        if s["p"] == g["p"]:
                            s["deaths"] += 1
                elif e == "logout":
                    if (s := open_.pop(str(g["uid"]), None)):
                        close(s, t, "logout")
                elif e == "platform":
                    if g["i"].startswith("Steam_"):
                        platforms.append((t, g["i"].split("_", 1)[1]))
                elif e == "server":
                    n = int(g["n"])
                    if not samples or t - samples[-1][0] >= cls.SAMPLE_EVERY - 5 or n != samples[-1][1]:
                        samples.append([round(t), n, int(g["zdos"])])  # [t, players, world objects]
                    if g.get("time") is not None:
                        clock = {"t": round(t), "time": g["time"], "src": "server"}
                    if n == 0:
                        for u in list(open_):
                            close(open_.pop(u), t, "timeout")
                elif e == "stop":  # a clean shutdown (plugin 1.17.0+)
                    for u in list(open_):
                        close(open_.pop(u), t, "restart")
                elif e == "start":
                    for u in list(open_):  # no stop seen: a crash, or an old archive
                        close(open_.pop(u), last_ts or t, "restart")
                    restarts.append(round(t))
                    version = g.get("game") or version
                elif e == "raid":
                    raid = {"t": round(t), "n": g["i"], "players": online()}
                    if "near" in g:
                        raid["near"] = sorted(g["near"])
                    raids.append(raid)
                elif e == "sleep":
                    # everyone slept: the world skips to the morning in 12 s (EnvMan.SkipToMorning)
                    days.append({"t": round(t), "d": int((g["time"] - DAY_LEN * MORNING) // DAY_LEN)})
                    clock = {"t": round(t + 12), "time": g["to"], "src": "sleep"}
                elif e == "location":  # old archives: the zone named by the log, before plugin 1.15.0 everyone online
                    key = f"{g['x']},{g['y']}"
                    z = zones.get(key)
                    if z is None:
                        z = zones[key] = {"x": g["x"], "y": g["y"], "t": round(t), "l": [], "by": online()}
                    if g["i"] not in z["l"]:
                        z["l"].append(g["i"])
                elif e == "zone":  # plugin 1.15.0+: who was near when the zone was generated (every zone, exact)
                    zx, zy = (int(v) for v in g["i"].split(","))
                    z = zones.get(f"{zx},{zy}")
                    if z is None:
                        z = zones[f"{zx},{zy}"] = {"x": zx, "y": zy, "t": round(t), "l": []}
                    z["by"], z["exact"] = sorted(set(g.get("by") or [])), True
                    for loc in g.get("l") or []:  # 1.17.0+: the location placed in it
                        if loc not in z["l"]:
                            z["l"].append(loc)
                elif e == "peak":  # highest per minute, not summed: the hour keeps the highest
                    k = (int(t // 3600 * 3600), g["p"], g["i"])
                    peaks[k] = max(peaks.get(k, float("-inf")), float(g["n"]))
                elif e in FEATS:
                    a, b = FEATS[e]
                    feats.append([round(t), g["p"], e, g.get(a), g.get(b) if b else None])
                elif e == "enter":  # into a dungeon (plugin Dungeons.cs); x / z: its entrance
                    inside[g["p"]] = v = [round(t), g["p"], g["i"], g["x"], g["z"], None]
                    visits.append(v)
                elif e == "leave":
                    v = inside.pop(g["p"], None)
                    if v is None or v[2] != g["i"]:  # its enter predates the archive
                        visits.append(v := [round(t - g.get("s", 0)), g["p"], g["i"], g["x"], g["z"], None])
                    v[5] = int(g.get("s", 0))
                elif e in CUSTODY:  # one line per move, snapped to the 64 m zone like everything players own
                    x, z = (int((v + 32) // 64 * 64) for v in (g["x"], g["z"]))
                    custody[(g["i"], g.get("c", ""), int(g.get("q", 1)))].append(
                        [round(t), g["p"], e, g.get("k", ""), x, z, int(g["n"])])
                else:
                    gather[(int(t // 3600 * 3600), g["p"], e, g["i"])] += int(g["n"])
            except (ValueError, KeyError, TypeError, AttributeError):
                pass
            if g.get("e") not in cls.BOOT:
                last_ts = t

        live = []
        for s in open_.values():
            s["e"] = None
            s["end"] = "online"
            live.append(s)
        sessions.extend(live)
        sessions.sort(key=lambda s: s["s"])
        visits.sort(key=lambda v: v[0])  # a leave without its enter (before the archive) comes in at its leave time
        for s in sessions:
            s["s"] = round(s["s"])
            if s["e"] is not None:
                s["e"] = round(s["e"])

        return {
            "version": version,
            "clock": clock,
            "_votes": votes,  # private: popped by build()
            "online": sorted({s["p"] for s in live}),
            "day": days[-1]["d"] if days else None,
            "sessions": sessions,
            "deaths": deaths,
            "raids": raids,
            "days": days,
            "restarts": restarts,
            "zones": sorted(zones.values(), key=lambda z: z["t"]),
            "samples": samples,
            # [hour start, player, "pick" | "fell" | "mine", prefab, count]
            "gather": [[*k, n] for k, n in sorted(gather.items())],
            # gear moves per copy, the last CUSTODY_KEEP, oldest first:
            # [item, crafter, quality, [[t, player, event, kind, x, z, n]]]
            "custody": [[i, c, q, ev[-CUSTODY_KEEP:]] for (i, c, q), ev in sorted(custody.items())],
            # dungeon visits, oldest first: [t entered, player, location prefab, entrance x, z, seconds inside (None: still in)]
            "visits": visits,
            # body & movement maxima per hour: [hour start, player, hp|st|eitr|y|v_foot|v_swim|v_boat|v_ride|hit, value]
            "peaks": [[*k, v] for k, v in sorted(peaks.items())],
            # single feats, oldest first: [t, player, sprint|closecall|fall, m|hp|h, s|max|None]
            "feats": feats,
        }


PARSERS = {"valheim": Valheim}


# --------------------------------------------------------------------------

DAY_LEN, MORNING = 1800, 0.15  # EnvMan: seconds per in-game day; a day starts at this fraction


def game_day(clock, sessions, now):
    """In-game day now. The world clock only runs while someone is connected, so it is the
    anchor plus the time anyone was online since (matches the sleep log to ~0.5 %)."""
    spans = sorted((max(s["s"], clock["t"]), min(s["e"] if s["e"] is not None else now, now)) for s in sessions)
    spans = [(x, y) for x, y in spans if y > x]
    on, end = 0, float("-inf")
    for x, y in spans:
        if y > end:
            on += y - max(x, end)
            end = y
    return int((clock["time"] + on - MORNING * DAY_LEN) // DAY_LEN)


def accounts(votes, override=None):
    """{steam id: [characters, most joins first]}. Two players joining at once can be
    paired the wrong way round, so each character goes to the account it joined with most."""
    best = {}
    for (sid, name), n in votes.items():
        if n > best.get(name, (None, 0))[1]:
            best[name] = (sid, n)
    out = {}
    for name, (sid, _n) in sorted(best.items(), key=lambda x: -x[1][1]):
        out.setdefault(sid, []).append(name)
    for sid, names in (override or {}).items():  # config wins
        for other in out.values():
            other[:] = [n for n in other if n not in names]
        out[sid] = list(names)
    return {sid: names for sid, names in out.items() if names}


def build(server, cfg, sdir, evs):
    """data.json from the events (events.load(), oldest first) and what the world save, RCON and Steam added."""
    now = time.time()
    data = PARSERS[server["game"]].rebuild(evs, now)
    votes = data.pop("_votes", None)
    if server.get("steam") and votes is not None:
        _save_json(os.path.join(sdir, "accounts.json"), accounts(votes, server["steam"].get("accounts")))
    data.update({
        "id": server["id"],
        "title": server["title"],
        "game": server["game"],
        "tz": cfg.get("tz", "UTC"),
        "generated": round(now),
        "interval": cfg.get("interval", 3600),
        "first": round(evs[0]["t"]) if evs else round(now),
    })
    # what counts how much: scoring.json with the config's overrides (scoring.py; checked when the collector starts)
    data["scoring"] = scoring.publish(cfg, server)
    # planned downtime (server "maintenance": [{"from", "to", "note"}], ISO 8601): the page doesn't count it as down
    data["maintenance"] = [[_iso(m["from"]), _iso(m["to"]), m.get("note", "")] for m in server.get("maintenance", [])]
    world = _load_json(os.path.join(sdir, "world.json"), None)
    if world:
        # the raw pet list carries platform ids ("named by"); pets.public() is the published form
        world = {k: v for k, v in world.items() if k != "pets"}
        data["world"] = world
        data["pets"] = pets.public(sdir, evs)
        hist = []
        hpath = os.path.join(sdir, "world_history.jsonl")
        if os.path.exists(hpath):
            with open(hpath) as f:
                hist = [json.loads(r) for r in f if r.strip()]
        data["world_history"] = hist
        # the hourly save is usually a fresher anchor than the last sleep
        if world.get("net_time") is not None and (not data.get("clock") or world["t"] > data["clock"]["t"]):
            data["clock"] = {"t": world["t"], "time": world["net_time"], "src": "save"}
    if server.get("rcon") and (live := rcon.live_world(sdir, now, cfg.get("interval", 3600))):
        # fresher than any save: the keys as they are now, and when new ones appeared
        if world:
            world["keys"] = live["keys"]
            world["bosses"] = [[k, n, k in live["keys"]] for k, n, _ in world["bosses"]]
        data["keys_live"] = live["t"]
        data["key_times"] = live["first"]
        if not data.get("clock") or live["t"] > data["clock"]["t"]:
            data["clock"] = {"t": live["t"], "time": live["time"], "src": "rcon"}
    if data.get("clock"):
        data["day"] = game_day(data["clock"], data["sessions"], now)  # the logged day lags a sleep behind
    if (terrain := _load_json(os.path.join(sdir, "terrain.json"), None)):
        data["terrain"] = {"v": terrain["t"], "size": terrain["size"], "extent": terrain["extent"]}
    if server.get("support"):  # optional link on the page (url, label, text)
        data["support"] = server["support"]
    if server.get("steam"):
        data["steam"] = steam.public(sdir, server["steam"]["app"])
    if server.get("rcon") and (pos := rcon.public(sdir, now, cfg.get("interval", 3600))):
        data["positions"] = pos
    if server.get("rcon") and (pl := rcon.portals(sdir, now, cfg.get("interval", 3600))):
        data["portals_live"] = pl
    if server.get("rcon") and (eq := rcon.equipment(sdir, now, cfg.get("interval", 3600))):
        data["equipment"] = eq
    # boss fights from the plugin's combat lines (fights.py); boss flags and health from the extracted game data
    creatures = (_load_json(os.path.join(DATA_DIR, "icons", "valheim", "creatures.json"), {})
                 if server["game"] == "valheim" else {})
    data["fights"] = fights.build(evs, data["deaths"], creatures, now)
    # best trading-card tier each player reached, kept by notify.py (a minute behind)
    if (cards := _load_json(os.path.join(sdir, "notify.json"), {}).get("cards")):
        data["cards"] = cards
    outdir = os.path.join(DATA_DIR, "site", server["id"])
    os.makedirs(outdir, exist_ok=True)
    chunks.write(outdir, json.loads(json.dumps(data)))  # for the page, in pieces: index.json + c/ (chunks.py)
    if os.path.exists(old := os.path.join(outdir, "data.json")):  # the whole thing, written until 1.20.3
        os.remove(old)
    return data


# --------------------------------------------------------------------------
# World saves

# Location (not prefab) names the altar lookup needs; the asset manifest only
# lists prefabs.
ALTARS = ("Eikthyrnir", "GDKing", "Bonemass", "Dragonqueen", "GoblinKing", "Mistlands_DvergrBossEntrance1", "FaderLocation")


def _iso(s):
    return round(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def _load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def _save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def world_update(server, cfg, sdir):
    wcfg = server["world"]
    state_path = os.path.join(sdir, "state.json")
    state = _load_json(state_path, {})
    current = _load_json(os.path.join(sdir, "world.json"), {})
    stale = current.get("schema") != valheim_world.SCHEMA  # new parser output: don't wait for the hour
    if not stale and time.time() - state.get("world_checked", 0) < wcfg.get("interval", 3600) - 30:
        return
    api = sources.source(wcfg)
    files = api.list(wcfg["dir"])
    save = valheim_world.latest_save(files)
    state["world_checked"] = time.time()
    if save is None or (save == state.get("world_save") and not stale):
        _save_json(state_path, state)
        return

    # Prefab names come from the game's own asset manifest; refetch when the
    # game files change (manifest mtime), not every run.
    names_path = os.path.join(sdir, "prefabs.json")
    names = _load_json(names_path, {})
    mdir, mfile = os.path.split(wcfg["manifest"])
    m_at = valheim_world.mtime(api.list(mdir), mfile)
    if not names.get("cats") or names.get("mtime") != m_at:
        names = {"mtime": m_at, "cats": valheim_world.prefab_index(api.get(wcfg["manifest"]))}
        _save_json(names_path, names)
        log(f"[{server['id']}] world: {len(names['cats'])} prefabs from manifest")
    lookup = {valheim_world.stable_hash(n): n for n in list(names["cats"]) + list(ALTARS)}

    players_path = os.path.join(sdir, "players.json")
    players = {int(k): v for k, v in _load_json(players_path, {}).items()}
    t0 = time.time()
    snap = valheim_world.snapshot(lambda n: api.get(f"{wcfg['dir']}/{n}"), files, save, lookup, players, names["cats"])
    snap["t"] = valheim_world.mtime(files, f"_main.{save}.ok") or round(time.time())
    # the players' shared map (cartography tables) as the map's fog mask, next to data.json
    if (ex := snap.pop("_explored", None)):
        _write_site(server, "explored.png", mapimg.explored_png(ex["size"], ex["cells"]))
        snap["map"]["explored"] = {"v": save, "size": ex["size"], "px": ex["px"]}
    _save_json(players_path, {str(k): v for k, v in players.items()})
    _save_json(os.path.join(sdir, "world.json"), snap)
    pets.update(sdir, snap)
    if save != state.get("world_save"):  # a schema re-read of the same save adds no history
        with open(os.path.join(sdir, "world_history.jsonl"), "a") as f:
            f.write(json.dumps({
                "t": snap["t"], "save": save, "v": valheim_world.SCHEMA, "keys": snap["keys"],
                "pieces": {p: v["total"] for p, v in snap["pieces"].items()},
                "tames": sum(n for _, n in snap["tames"]),
                "stored": sum(e.get("kept", 0) for e in snap["items"].values()),
                "zones": snap.get("zones"),  # generated zones: health.py compares them with the plugin's zone events
            }, ensure_ascii=False) + "\n")
    state["world_save"] = save
    _save_json(state_path, state)
    log(f"[{server['id']}] world: save {save}, {snap['objects']} objects in {time.time() - t0:.1f}s")


def _write_site(server, name, data):
    outdir = os.path.join(DATA_DIR, "site", server["id"])
    os.makedirs(outdir, exist_ok=True)
    tmp = os.path.join(outdir, f".{name}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, os.path.join(outdir, name))


def terrain_update(server, sdir):
    """The world's terrain for the map: sampled once per seed by the server plugin (plugin/Terrain.cs),
    drawn here into terrain.png when the plugin's terrain.json names a file not drawn yet."""
    wcfg = server["world"]
    state_path = os.path.join(sdir, "state.json")
    state = _load_json(state_path, {})
    if time.time() - state.get("terrain_checked", 0) < 600:
        return
    state["terrain_checked"] = time.time()
    _save_json(state_path, state)
    api = sources.source(wcfg)
    tdir = wcfg.get("terrain", "BepInEx/gamestats")
    try:
        files = api.list(tdir)
    except OSError:  # no plugin output (yet): not there, whatever the source
        return
    if "terrain.json" not in files:
        return
    meta = json.loads(api.get(f"{tdir}/terrain.json"))
    current = _load_json(os.path.join(sdir, "terrain.json"), {})
    if current.get("file") == meta["file"] and current.get("t") == meta["t"]:
        return
    t0 = time.time()
    size, extent, seed, heights, biomes = mapimg.parse_terrain(api.get(f"{tdir}/{meta['file']}"))
    _write_site(server, "terrain.png", mapimg.terrain_png(size, extent, heights, biomes))
    _save_json(os.path.join(sdir, "terrain.json"),
               {"file": meta["file"], "t": meta["t"], "seed": seed, "size": size, "extent": extent})
    log(f"[{server['id']}] terrain: {meta['file']} drawn in {time.time() - t0:.1f}s")


def run_once(cfg):
    for server in cfg["servers"]:
        sdir = os.path.join(DATA_DIR, server["id"])
        os.makedirs(sdir, exist_ok=True)
        failed = {}  # step -> error, for health.py
        try:
            status, evs = collect(server, sdir)
        except Exception as e:
            # Keep serving the previous data; the next cycle carries on from the same number.
            log(f"[{server['id']}] events failed: {type(e).__name__}: {e}")
            alert(server, cfg, sdir, {"collector:events": f"no events from the plugin's store: {e}"}, partial=True)
            continue
        try:  # the combat results from the plugin's facts, where it stored them (combat.py)
            evs = combat.recompute(evs, os.path.join(sdir, "combat.json"))
        except Exception as e:  # never at the stats' expense: the plugin's own results stay
            log(f"[{server['id']}] combat failed: {type(e).__name__}: {e}")
            failed["combat"] = f"{type(e).__name__}: {e}"
        if server.get("world"):
            try:
                world_update(server, cfg, sdir)
            except Exception as e:  # keep serving the last snapshot
                log(f"[{server['id']}] world update failed: {type(e).__name__}: {e}")
                failed["world"] = f"{type(e).__name__}: {e}"
            try:
                terrain_update(server, sdir)
            except Exception as e:  # keep the last terrain
                log(f"[{server['id']}] terrain update failed: {type(e).__name__}: {e}")
                failed["terrain"] = f"{type(e).__name__}: {e}"
        if server.get("steam"):
            key = os.environ.get("STEAM_API_KEY")
            try:
                if key:
                    steam.update(server, sdir, DATA_DIR, key)
            except Exception as e:  # keep the last achievements
                log(f"[{server['id']}] steam update failed: {type(e).__name__}: {e}")
                failed["steam"] = f"{type(e).__name__}: {e}"
        if server.get("rcon"):
            try:
                rcon.update(server, sdir)
            except Exception as e:  # keep the last-seen positions
                log(f"[{server['id']}] rcon update failed: {type(e).__name__}: {e}")
                failed["rcon"] = f"{type(e).__name__}: {e}"
        data = build(server, cfg, sdir, evs)
        if server.get("notify"):
            try:
                notify.run(server, sdir, data)
            except Exception as e:  # never let a chat post break the stats
                log(f"[{server['id']}] notify failed: {type(e).__name__}: {e}")
                failed["notify"] = f"{type(e).__name__}: {e}"
        log(f"[{server['id']}] +{status['added']} events{' (from the files)' if status.get('files') else ''}, "
            f"{len(data['sessions'])} sessions, {len(data['online'])} online")
        problems = health.check(evs, data, time.time(), cfg.get("plugin_version"), status, health.sources(sdir))
        problems.update({f"collector:{k}": v for k, v in failed.items()})
        alert(server, cfg, sdir, problems)


def collect(server, sdir):
    """New events from the plugin's store — over RCON, else its files through the world's file source — and then all
    of them."""
    db = events.open_db(sdir)
    try:
        password = os.environ.get(server["rcon"].get("password_env", ""), "")
        try:
            status = events.sync(server, db, password)
        except (OSError, RuntimeError, ValueError) as e:
            try:
                files = sources.source(server.get("world"))
            except ValueError:
                files = None
            if files is None:
                raise
            status = events.sync_files(server, db, files)
            status["rcon_error"] = f"{type(e).__name__}: {e}"
        events.import_archive(db, sdir)
        return status, events.load(db)
    finally:
        db.close()


def alert(server, cfg, sdir, problems, partial=False):
    try:
        health.run(server, sdir, problems, os.environ.get((cfg.get("alerts") or {}).get("webhook_env", ""), ""),
                   partial=partial)
    except Exception as e:  # never let an alert break the stats
        log(f"[{server['id']}] health failed: {type(e).__name__}: {e}")


def main():
    with open(CONFIG) as f:
        cfg = json.load(f)
    try:  # a mistake in the scoring overrides stops it here, not every round
        for server in cfg["servers"]:
            scoring.publish(cfg, server)
    except ValueError as e:
        log(f"config: {e}")
        sys.exit(2)
    if "--once" in sys.argv:
        run_once(cfg)
        return
    interval = cfg.get("interval", 3600)
    # As PID 1 an unhandled SIGTERM is ignored and the pod waits out its grace
    # period; stop between cycles so an archive append is never cut short.
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    while not stop.is_set():
        run_once(cfg)
        # Align to the interval grid.
        stop.wait(interval - time.time() % interval)
    log("SIGTERM, exiting")


if __name__ == "__main__":  # python3 -m valheim_gamestats (__main__.py) is the usual way in
    main()
