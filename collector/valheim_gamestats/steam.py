"""Steam achievements for the gamestats collector.

The plugin's login events carry each player's platform ID (Steam_<id64>) with
their character (older history: the server log's "received local Platform ID",
paired with the character that spawned next — see Valheim.rebuild), and the
collector keeps the result in <server-id>/accounts.json. This module asks the
Steam Web API for those accounts' achievements:

  GetSchemaForGame                        names, descriptions, icons  (daily)
  GetGlobalAchievementPercentagesForApp   global unlock rates         (daily)
  GetPlayerAchievements                   per account, unlock times   (every "interval")
  GetUserStatsForGame                     per account, Valheim's 14 Steam stats (same)

Steam IDs stay in <server-id>/steam.json on the PVC; public() turns that into
the "steam" block of data.json, keyed by character name. GetPlayerAchievements
needs the player's Steam privacy "Game details" set to public — otherwise the
account shows as private. Stats are lifetime counters of the account across
all worlds, like the achievements; Valheim has none for kills. Icons are downloaded once into DATA_DIR/steam/ and
served by nginx, so visitors' browsers never talk to Steam.

Stdlib only.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "valheim-gamestats"
API = "https://api.steampowered.com"
# The schema still points at steamcdn-a.akamaihd.net, which now answers 404 for app images.
CDN = "https://shared.akamai.steamstatic.com/community_assets/images/apps/{app}/{file}"
DAILY = 86400
# Hidden achievements come without a description, even once unlocked. Ours, for the ones that
# are unambiguous; the page only shows them after a tracked player has unlocked the achievement.
HIDDEN_DESC = {
    "Arrived": "Arrive in Valheim.",
    "FirstDeath": "Die for the first time.",
    "Boss1Eikthyr": "Defeat Eikthyr.",
    "Boss2Elder": "Defeat The Elder.",
    "Boss3Bonemass": "Defeat Bonemass.",
    "Boss4Moder": "Defeat Moder.",
    "Boss5Yagluth": "Defeat Yagluth.",
    "Boss6Queen": "Defeat The Seeker Queen.",
    "Boss7Fader": "Defeat Fader.",
    "Boss8FrozenKing": "Defeat Kall Fimbulbringer.",
    "DeathByTree": "Get killed by a falling tree.",
    "SailEdge": "Sail to the edge of the world.",
    "BuildDyrnwyn": "Forge Dyrnwyn.",
}


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


def _get(path, **params):
    url = f"{API}/{path}/?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 403:  # private profile: the body still says why
            with e:
                return json.load(e)
        raise


def _load(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def _save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _icon(app, url, icon_dir):
    """Download an icon once; returns the file name (content-hashed by Steam) or None."""
    name = os.path.basename(urllib.parse.urlparse(url or "").path)
    if not re.fullmatch(r"[0-9a-f]{40}\.(jpg|png)", name):
        return None
    path = os.path.join(icon_dir, name)
    if not os.path.exists(path):
        req = urllib.request.Request(CDN.format(app=app, file=name), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
        with open(path + ".tmp", "wb") as f:
            f.write(body)
        os.replace(path + ".tmp", path)
    return name


def update(server, sdir, data_dir, key):
    """Refresh <sdir>/steam.json; cheap to call every cycle (everything is rate-limited here)."""
    scfg = server["steam"]
    app = scfg["app"]
    path = os.path.join(sdir, "steam.json")
    st = _load(path, {})
    now = time.time()
    accounts = _load(os.path.join(sdir, "accounts.json"), {})

    if now - st.get("schema_t", 0) > DAILY:
        game = _get("ISteamUserStats/GetSchemaForGame/v2", appid=app, l="english", key=key).get("game", {})
        ach = (game.get("availableGameStats") or {}).get("achievements") or []
        if ach:
            icon_dir = os.path.join(data_dir, "steam", str(app))
            os.makedirs(icon_dir, exist_ok=True)
            st["schema"] = [{
                "k": a["name"], "n": a.get("displayName") or a["name"],
                "d": a.get("description") or HIDDEN_DESC.get(a["name"], ""), "hidden": bool(a.get("hidden")),
                "icon": _icon(app, a.get("icon"), icon_dir), "gray": _icon(app, a.get("icongray"), icon_dir),
            } for a in ach]
            st["schema_t"] = now
            log(f"[{server['id']}] steam: schema with {len(ach)} achievements")
    if now - st.get("pct_t", 0) > DAILY:
        rows = _get("ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2", gameid=app)
        st["pct"] = {a["name"]: float(a["percent"]) for a in (rows.get("achievementpercentages") or {}).get("achievements", [])}
        st["pct_t"] = now

    players = st.setdefault("players", {})
    for sid in accounts:
        p = players.setdefault(sid, {})
        if now - p.get("t", 0) < scfg.get("interval", 600):
            continue
        ps = _get("ISteamUserStats/GetPlayerAchievements/v1", appid=app, steamid=sid, key=key).get("playerstats") or {}
        p["t"] = now
        if ps.get("success"):
            p["ok"] = True
            p["unlocked"] = {a["apiname"]: a["unlocktime"] for a in ps.get("achievements", []) if a.get("achieved")}
        else:  # keep what we saw while it was public
            p["ok"] = False
            p["error"] = ps.get("error") or "unknown"
        if p["ok"]:
            try:
                us = _get("ISteamUserStats/GetUserStatsForGame/v2", appid=app, steamid=sid, key=key).get("playerstats") or {}
                p["stats"] = {s["name"]: s["value"] for s in us.get("stats") or []}
            except urllib.error.HTTPError as e:  # 400 while game details are private
                log(f"[{server['id']}] steam: stats unavailable for one account (HTTP {e.code})")
    for sid in [s for s in players if s not in accounts]:
        del players[sid]
    _save(path, st)


def public(sdir, app):
    """The data.json view: no Steam IDs, accounts keyed by their main character."""
    st = _load(os.path.join(sdir, "steam.json"), {})
    accounts = _load(os.path.join(sdir, "accounts.json"), {})
    if not st.get("schema"):
        return None
    pct = st.get("pct", {})
    players = {}
    for sid, chars in accounts.items():
        p = st.get("players", {}).get(sid)
        if not p or not chars:
            continue
        players[chars[0]] = {"chars": chars, "status": "ok" if p.get("ok") else "private",
                             "checked": round(p["t"]), "unlocked": p.get("unlocked", {}), "stats": p.get("stats", {})}
    return {
        "app": app,
        "achievements": [{**a, "pct": pct.get(a["k"])} for a in st["schema"]],
        "players": players,
    }
