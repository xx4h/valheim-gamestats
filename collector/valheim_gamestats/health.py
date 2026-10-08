"""Runtime checks: the failures the page can't show, posted to an admin webhook within minutes.

A broken plugin doesn't fail loudly — the stats just stop growing, and zeroes look like a quiet evening. These
checks look at what should be there and isn't (docs/ATTRIBUTION.md, "Never: silent gaps"), all from the events
(events.py) and how fetching them went — nothing from the game server's log:

  error:<area>  the plugin warned ("combat: Method has zero rva" — a DLL overwritten while loaded, every hook in it
                dead until the server restarts; "patch: …" — a game update broke a hook; "copies: …" — two plugins)
  noplugin      players online since the last server start, but the plugin never said it started; or the server
                doesn't know the plugin's RCON command
  rcon          the events came from the store's files: RCON can't be reached
  gap           numbers missing in the plugin's store: exactly that many events are lost
  store         the plugin's store was replaced or lost events (its numbers start over or went back)
  crash:<t>     the server came back without having stopped cleanly (plugin 1.17.0+ records a clean stop)
  hooks         the plugin started with hooks missing (a game update broke them; each one's stats stay empty)
  heartbeat     no per-minute server sample from the plugin: its timers stopped, every per-minute stat with them
  unjoinable    the server runs, but its crossplay (PlayFab) session didn't become active — or PlayFab failed: nobody can
                join until a restart (plugin 1.20.0+; 2026-10-07 it took players' reports to notice)

Cross-checks against sources the plugin doesn't write (sources()), each a way the plugin could miss something:
  missed:login   ValheimRcon lists a player online that has no session (a login or spawn event missed)
  missed:logout  a session is open, but ValheimRcon doesn't list the player (the logout missed: playtime grows)
  missed:death   a new tombstone (the game's own record of a death) without a death event for its owner
  missed:zones   the world save has more newly generated zones than the plugin reported between two saves
  duplicate     the plugin started twice in one boot: two copies in plugins/ (e.g. the old GamestatsEquipment.dll next to
                ValheimGamestats.dll) — every event counts twice
  silent        a player online for a while with no plugin line at all (the plugin samples everyone every second)
  quiet:<kind>  hours of play without one combat / gathering / movement line
  zones         zones generated with plugin >= 1.15.0 running but no "zone" line: credit falls back to everyone online
  version       the plugin running is older than this release's (major.minor: a patch release needs no new plugin)
  collector:<step>  a collector step failed

check() is pure (events + data.json + fetch status in, problems out); run() keeps state, debounces and posts.

Stdlib only.
"""
import json
import os
import time
import urllib.error
from collections import Counter

from . import notify

ERROR_WINDOW = 30 * 60   # plugin warnings this recent count
SILENT = 10 * 60         # online this long without a single plugin line
SETTLE = 5 * 60          # a zone's line comes with its generation; give the log time to arrive
VITALS = (1, 14)   # every online player gets a line each minute (peaks) since this version
# what every hour of play produces, how many player-hours without it are suspicious, since which plugin version
QUIET = {
    "combat": ({"dmg", "kill", "taken", "hit", "wdmg", "wkill"}, 3 * 3600, (1, 0)),
    "gathering": ({"pick", "fell", "mine"}, 2 * 3600, (1, 0)),
    "movement": ({"dist"}, 30 * 60, VITALS),
}
ZONES = (1, 15)
STOPS = (1, 17)    # the plugin records a clean stop, logins, deaths and a per-minute sample since this version
HEARTBEAT = 3 * 60  # the plugin samples the server every minute
LOBBY = (1, 20)     # the plugin reports the crossplay session since this version
LOBBY_WAIT = 3 * 60  # a session is active within seconds of the world being up
FRESH = 3 * 60      # an RCON poll this old still tells who is online
DEATH_SLACK = 5 * 60  # a tombstone is first seen at the next poll after the death
CRASH_SHOWN = 30 * 60  # a crash is news for this long
BOOT = 10 * 60     # the plugin says it started ~1 min before the server's "New session server"
PERSIST = 3        # checks in a row before an alert goes out (one per collector cycle)
REMIND = 6 * 3600  # still broken: say so again


def _ver(s):
    try:
        return tuple(int(x) for x in s.split(".")[:3])
    except (AttributeError, ValueError):
        return ()


def sources(sdir):
    """What the cross-checks compare with, from files the plugin doesn't write: ValheimRcon's player list
    (rcon.py positions.json), the game's tombstones (tombstones.json) and the world saves (world_history.jsonl)."""
    def load(name, default):
        try:
            with open(os.path.join(sdir, name)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return default
    pos = load("positions.json", {})
    tombs = load("tombstones.json", {})
    saves = []
    try:
        with open(os.path.join(sdir, "world_history.jsonl")) as f:
            saves = [h for h in (json.loads(r) for r in f if r.strip()) if h.get("zones") is not None]
    except (OSError, ValueError):
        pass
    return {
        "connected": (pos.get("ok", 0), pos.get("connected")),
        "tombs": [(t, tombs.get("owners", {}).get(i)) for i, t in tombs.get("seen", {}).items()
                  if tombs.get("owners", {}).get(i)],
        "saves": [(h["t"], h["zones"]) for h in saves[-2:]],
    }


def check(evs, data, now, expect=None, status=None, src=None):
    """evs: the events (events.py), oldest first; data: the built data.json; expect: plugin version this release
    ships; status: what events.sync() said; src: sources(). Returns {key: message} — what is wrong now."""
    out = {}
    restarts = sorted(data.get("restarts") or [0])
    restart, before = restarts[-1], (restarts[-2] if len(restarts) > 1 else 0)
    started, version = None, None   # the plugin's last start: wall time, version
    starts = []                     # every start: (wall time, version)
    last = {}                       # player -> last plugin event
    kinds = {k: 0 for k in QUIET}   # kind -> last event of it
    warns = {}                      # area -> [count, last message]
    boot = None                     # the server's boots: [start time, stopped cleanly, plugin version]
    crash = None
    hooks = None                    # what the plugin's last start said about its hooks
    last_sample = 0
    up = None                       # the last start: [time, backend, lobby states since]
    deaths = {}                     # player -> [death times]
    zone_times = []
    for g in evs:
        t, e = g["t"], g.get("e")
        if e == "plugin":
            started, version = t, g.get("i")
            starts.append((t, version))
            hooks = g if "hooks" in g else None
        elif e == "warn":
            if now - t <= ERROR_WINDOW:
                w = warns.setdefault(g.get("i", "plugin"), [0, ""])
                w[0] += 1
                w[1] = g.get("msg", "")
        elif e == "stop":
            if boot:
                boot[1] = True
        elif e == "start":
            if boot and not boot[1] and _ver(boot[2]) >= STOPS:
                crash = t
            boot = [t, False, version]
            up = [t, g.get("backend"), []]
        elif e == "lobby":
            if up:
                up[2].append((g.get("i"), g.get("msg")))
        else:
            if e == "server":
                last_sample = t
            elif e == "death":
                deaths.setdefault(g.get("p"), []).append(t)
            elif e == "zone":
                zone_times.append(t)
            if g.get("p"):
                last[g["p"]] = t
            for k, (kinds_of, _, _) in QUIET.items():
                if e in kinds_of:
                    kinds[k] = t
    this_boot = lambda t: t >= restart - BOOT and t > before  # its start line comes ~1 min before the server's
    running = started is not None and this_boot(started)

    for area, (n, msg) in warns.items():
        hint = " — the DLL was replaced while loaded; restart the server" if "zero rva" in msg else ""
        out[f"error:{area}"] = f"plugin error in {area}, {n}× in the last {ERROR_WINDOW // 60} min: {msg}{hint}"

    copies = [v for t, v in starts if this_boot(t)]
    if running and len(copies) > 1:
        out["duplicate"] = (f"the plugin started {len(copies)}× in this boot ({', '.join(copies)}): more than one copy in "
                            "BepInEx/plugins — every event counts twice; remove all but one and restart")

    online = [s for s in data.get("sessions", []) if s.get("e") is None]
    if online and not running and any(now - max(s["s"], restart) >= SILENT for s in online):
        out["noplugin"] = "players online, but the plugin hasn't started since the server did — not installed or failed to load"
    if running and _ver(version) >= VITALS:
        mute = [f"{s['p']} ({round((now - max(last.get(s['p'], 0), s['s'], started)) / 60)} min)" for s in online
                if now - max(s["s"], started) >= SILENT and now - last.get(s["p"], 0) >= SILENT]
        if mute:
            out["silent"] = f"no plugin line while online: {', '.join(mute)}"
    for k, (_, limit, since) in QUIET.items():
        if not running or _ver(version) < since:
            continue
        played = sum(max(0, (s["e"] if s.get("e") is not None else now) - max(s["s"], kinds[k], started))
                     for s in data.get("sessions", []))
        if played >= limit:
            out[f"quiet:{k}"] = f"no {k} line in {played / 3600:.1f} player-hours of play"
    if running and _ver(version) >= ZONES:
        missing = [z for z in data.get("zones", []) if z["t"] >= started and not z.get("exact") and now - z["t"] >= SETTLE]
        if missing:
            z = missing[-1]
            out["zones"] = (f"{len(missing)} zone(s) generated without the plugin's zone line (last {z['x']},{z['y']}): "
                            "credit falls back to everyone online")
    if expect and running and _ver(version)[:2] != _ver(expect)[:2]:
        out["version"] = f"plugin {version} running, this release ships {expect}"

    if running and hooks and hooks.get("failed"):
        out["hooks"] = (f"the plugin started with {len(hooks['failed'])} of {hooks.get('of', '?')} hooks missing: "
                        f"{', '.join(hooks['failed'])} — their stats stay empty until it is fixed")
    stores = running and _ver(version) >= STOPS
    if stores and now - max(last_sample, started) >= HEARTBEAT and not (status or {}).get("rcon_error"):
        out["heartbeat"] = (f"no server sample from the plugin for {round((now - max(last_sample, started)) / 60)} min: "
                            "its timers stopped")
    if running and _ver(version) >= LOBBY and up and up[1] == "PlayFab" and up[0] >= started:
        failed = [m for s, m in up[2] if s == "failed"]
        if failed:
            out["unjoinable"] = (f"PlayFab failed ({', '.join(m or '?' for m in failed)}): "
                                 "nobody can join until the server restarts")
        elif not any(s == "active" for s, _ in up[2]) and now - up[0] >= LOBBY_WAIT:
            out["unjoinable"] = (f"the crossplay session isn't active {round((now - up[0]) / 60)} min after the start: "
                                 "nobody can join — restart the server")
    src = src or {}
    ok, connected = src.get("connected") or (0, None)
    if stores and connected is not None and now - ok <= FRESH:
        sessions = set(data.get("online") or [])
        if (extra := sorted(set(connected) - sessions)):
            out["missed:login"] = f"online per ValheimRcon, but no session: {', '.join(extra)} — a login was missed"
        if (gone := sorted(sessions - set(connected))):
            out["missed:logout"] = f"session open, but not online per ValheimRcon: {', '.join(gone)} — a logout was missed"
    if stores:
        # counted, not matched by time: a tombstone is first seen whenever the collector polls next (after an outage,
        # much later). Every tombstone has a death; a death needs no tombstone (nothing to drop).
        tombs = Counter(o for t, o in src.get("tombs") or [] if t >= started + DEATH_SLACK)
        lost = sorted(f"{o} ({n} tombstones, {sum(1 for d in deaths.get(o, []) if d >= started)} deaths)"
                      for o, n in tombs.items() if n > sum(1 for d in deaths.get(o, []) if d >= started))
        if lost:
            out["missed:death"] = f"more new tombstones than death events since the plugin started: {', '.join(lost)}"
    saves = src.get("saves") or []
    if stores and len(saves) == 2 and saves[0][0] >= started:
        (t1, z1), (t2, z2) = saves
        logged = sum(1 for t in zone_times if t1 < t <= t2)
        if z2 - z1 > logged:
            out["missed:zones"] = f"the world save has {z2 - z1} new zones since the save before, the plugin reported {logged}"
    if crash and now - crash <= CRASH_SHOWN:
        out[f"crash:{round(crash)}"] = "the server came back without a clean stop: it crashed or was killed"
    status = status or {}
    if (err := status.get("rcon_error")):
        if "plugin" in err:
            out["noplugin"] = f"the server doesn't know the plugin's RCON command — is it loaded? ({err})"
        else:
            out["rcon"] = f"RCON can't be reached, events came from the store's files: {err}"
    if (gaps := status.get("gaps")):
        n = sum(b - a + 1 for a, b in gaps)
        out["gap"] = f"{n} event(s) missing from the plugin's store: " + ", ".join(f"{a}–{b}" for a, b in gaps)
    if status.get("new_store"):
        out["store"] = f"the plugin's store was replaced (id {status['new_store']}): its numbers started over"
    elif status.get("behind"):
        out["store"] = f"the plugin's store has only {status['behind'][0]} events, {status['behind'][1]} were read: it lost some"
    return out


def run(server, sdir, problems, webhook="", now=None, post=notify.post, partial=False):
    """problems: check() plus collector failures. Logs and posts (when there is a webhook) what newly persisted and
    what cleared; returns the posts. partial: only some checks ran (the log couldn't be read), nothing clears."""
    now = now or time.time()
    path = os.path.join(sdir, "health.json")
    state = {}
    if os.path.exists(path):
        with open(path) as f:
            state = json.load(f)
    seen = state.setdefault("seen", {})        # key -> checks in a row it was there
    alerted = state.setdefault("alerted", {})  # key -> last posted
    posts = []
    for k, msg in problems.items():
        seen[k] = seen.get(k, 0) + 1
        immediate = k.startswith(("error:", "gap", "store", "crash:", "unjoinable"))  # news at once, not a state to confirm
        if (seen[k] >= PERSIST or immediate) and (k not in alerted or now - alerted[k] >= REMIND):
            posts.append({"title": f"⚠ {server['id']}: {k}", "description": msg, "color": 0xD0402B})
            alerted[k] = now
    for k in [k for k in seen if k not in problems and not partial]:
        del seen[k]
        if alerted.pop(k, None) and not k.startswith(("gap", "crash:")):  # events, not states: nothing to resolve
            posts.append({"title": f"✓ {server['id']}: {k} resolved", "color": 0x3FA34D})
    for p in posts:
        print(time.strftime("%Y-%m-%dT%H:%M:%S"), f"[{server['id']}] health: {p['title']} {p.get('description', '')}", flush=True)
    if posts and webhook:
        try:
            for i in range(0, len(posts), 10):
                post(webhook, f"{server.get('title') or server['id']} health", posts[i:i + 10])
        except (urllib.error.URLError, OSError) as e:  # alerts go out again next cycle; a lost "resolved" is harmless
            print(f"[{server['id']}] health: post failed: {e}", flush=True)
            for k in problems:
                if alerted.get(k) == now:
                    del alerted[k]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)
    return posts
