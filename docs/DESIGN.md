# How it works

valheim-gamestats turns what happens on a Valheim dedicated server into a stats page. Three parts, one release:

```
  game server (Valheim + BepInEx)                 collector (Python, stdlib)                 web (nginx)
 ┌───────────────────────────────┐   RCON      ┌──────────────────────────────┐   files   ┌──────────────────┐
 │ ValheimGamestats plugin       │ gs_events → │ events.db (SQLite)           │ ───────→  │ index.json, c/…  │ → browser
 │  hooks → event store on disk  │ ←────────── │  → rebuild → data            │  /data    │ terrain.png, …   │   (site/app.js)
 │ ValheimRcon (RCON server)     │ players,    │  → pieces (chunks.py)        │           └──────────────────┘
 └───────────────────────────────┘ gear, clock │ health checks → admin alerts │
          │ world save (hourly)                │ notify → Discord feed        │
          └──── file source ─────────────────→ │ Steam Web API                │
                                               └──────────────────────────────┘
```

Nothing is read from the game server's log. Who gets credit for what is written down in [ATTRIBUTION.md](ATTRIBUTION.md);
every event and every `data.json` key, with its tests, in [events.json](events.json).

## 1. On the game server: the plugin

`ValheimGamestats.dll` is a BepInEx plugin (C#, Harmony). It hooks the server's own code where things happen and
records them as events:

| Hooks | Events |
|---|---|
| a character spawning or dying, a connection closing (`ZNet`) | `login` (with the Steam/platform id), `spawn`, `death` (with position), `logout` |
| the server starting and shutting down | `plugin` (version, hooks applied), `start` (world, game version, PlayFab or Steam), `stop` |
| a mob's or player's health dropping in a sync (`ZDO.Deserialize`) | damage dealt / taken, kills, hits, per weapon (`dmg`, `kill`, `taken`, `dw`, `kw`, …) |
| an object deleted by a client (`ZDOMan.RPC_DestroyZDO`) | pickups, felling, mining, gear picked up (`pick`, `fell`, `mine`, `carry`) |
| containers and item stands changing | loot, gear moves (`loot`, `take`, `put`, `off`, `on`) |
| once a second, every player's synced state | distance, peaks, sprints, falls, close calls, … (`dist`, `peak`, `sprint`, …) |
| zones generated, raids, sleeping, the crossplay session, pets | `zone` (who was near), `raid`, `sleep`, `lobby`, `petdeath`, `pethp` |
| once a minute | a `server` sample (connections, objects, world time) and the minute's sums |

Counts are summed per minute and player before they're written; one-off things (a death, a zone) are written at once.
Problems the plugin runs into are `warn` events (and a line in the server log, for people).

**The event store.** Events go to the plugin's own files on the server's disk, `BepInEx/gamestats/events/<UTC day>.jsonl`,
one JSON object per line, each with a sequence number and the time:

    {"s":1234,"t":1791370829290,"e":"kill","p":"Ragnar","i":"Troll","n":1}

The numbers make every event addressable: a reader asks for "everything after 1233" and a gap in the numbers is exactly
what's missing. The files live on the server's own volume, so restarts, crashes and a collector that's down lose
nothing. 90 days are kept (about 300 KB a day); a `store-id` file names the store, so a wiped store is noticed.

**RCON.** The plugin adds commands to ValheimRcon (the RCON server, a separate BepInEx plugin):

| Command | Answers |
|---|---|
| `gs_events <after>` | a header `{"id","head","oldest"}`, then the events after that number, as many as fit in one reply (~4 KB) |
| `equipment` | every online player's visible gear and looks |
| `tombstones` | levelled gear in every tombstone |
| `portals` | every portal and the one the game linked it to |

ValheimRcon's own `players`, `time` and `globalKeys` are used too.

**Terrain.** Once per world seed the plugin samples the terrain into `BepInEx/gamestats/terrain-<seed>.bin.gz`; the
collector reads it through the file source and draws the map from it.

## 2. The collector

A Python package (`collector/valheim_gamestats`, standard library only, run as `python3 -m valheim_gamestats`) that runs
once a minute. Per server:

1. **Events** (`events.py`): asks `gs_events` from the last number it has until nothing new comes, and stores the
   events in `<data>/<server>/events.db` (SQLite, unique by store and number). If RCON can't be reached (the server is
   down), it reads the same day files through the server's file source instead (`sources.py`: Pelican, a local
   directory or a script). History from before the plugin kept its own
   store (the server log, read from Loki) is imported once from `archive.jsonl`.
2. **World save** (`valheim_world.py`, hourly): reads the newest save through the file source and parses it: pieces and who built them, chests and what's in them, crafted gear and its crafter,
   pets, portals, beds, tombstones, signs, the shared map, generated zones. Only aggregates are kept.
3. **RCON** (`rcon.py`): players online and their positions (only those who share their position on the map), gear,
   tombstones, portals, the world clock and global keys (boss kills show within a minute).
4. **Steam** (`steam.py`, optional): achievements and stats of the players' accounts.
5. **Combat** (`combat.py`): in every plugin run that stored combat facts (events `cf`), the combat results — damage
   dealt and taken, kills, health paid, unaccounted kills and damage, summons — come from the collector's own rules
   (a port of the plugin's `CombatCore.cs`, pinned to the same expected sums on recorded fights in `tests/combat/`),
   replacing what the plugin sent for that run. A rule change (`combat.RULES`) recomputes every run with facts;
   runs whose facts didn't change come from `<server>/combat.json`. Older runs, without facts, keep the plugin's results.
6. **Rebuild**: all events, oldest first, into sessions, deaths, raids, zones, gathering per hour, boss fights
   (`fights.py`), pets (`pets.py`), peaks, feats, dungeon visits, gear moves — plus the world, RCON and Steam parts —
   into one JSON document, called `data.json` throughout (never written as one file since 1.20.4).
7. **Pieces** (`chunks.py`): that document in files for the page (section 3).
8. **Discord feed** (`notify.py`, optional): bosses, raids, medals, titles, the weekly recap.
9. **Health** (`health.py`): checks for what should be there and isn't, and posts to an admins' Discord webhook
   (section 4).

**Files under the data directory** (`/data` in the containers):

```
<server>/events.db            every event (SQLite)            <server>/world.json        the latest world save, aggregated
<server>/archive.jsonl        the old log archive (backup)    <server>/world_history.jsonl one line per save
<server>/positions.json       RCON: who's online, where       <server>/pets.json         every pet across saves
<server>/equipment.json       RCON: gear + gear history       <server>/accounts.json     Steam id → characters (private)
<server>/tombstones.json      RCON: tombstones seen           <server>/steam.json        achievements (private)
<server>/combat.json          combat results per plugin run (a cache of combat.py's)
<server>/notify.json          what was announced              <server>/health.json       alert state
site/<server>/index.json, c/  what the page loads             site/<server>/terrain.png, explored.png  map layers
icons/valheim/                item icons + game data, extracted by hand (tools/README.md)
steam/<app>/                  achievement icons
```

## 3. The page

A static page (`site/`: one `index.html`, `app.js`, `style.css`) behind nginx. nginx picks the server by the `Host`
header and serves its files from `/data/site/<server>/`.

**Getting the data.** The collector writes the data in pieces:

| File | Holds | Changes |
|---|---|---|
| `index.json` | the names of all the files below | every minute (the only file that changes in place) |
| `c/m<month>-…`, `c/w<week>-…`, `c/d<day>-…` | history: older than 4 weeks by month, then by week, this week by day (UTC) | almost never |
| `c/world-…`, `c/pets-…` | the world save, pets | with the hourly save |
| `c/custody-…`, `c/steam-…` | who has which gear, Steam | with gear moves, Steam checks |
| `c/scoring-…` | the scoring rules: `scoring.json` with the server's overrides ([SCORING.md](SCORING.md)) | with the config |
| `c/state-…` | the rest of the state (config, boss fights, cards, …) | rarely |
| `c/live-…` | today, what's still open (sessions, dungeon visits), positions, gear, clock | every minute |

Every file under `c/` is named by its content (`live-36797c1b1448aeba.json`) and served as `immutable`. The page polls
`index.json` every 20 s, fetches only names it doesn't have yet — usually just `live`, a few KB — and joins the files
back into exactly the data (`join` in `app.js`, `merge` in `chunks.py`; tested to give the same). A late event
for an old day changes that day's content, hence its name: the page fetches it again, nothing stale stays cached.

**Drawing.** Everything else happens in the browser: the range slider (default 30 days), rankings, titles, player and
item pages, the map with its filter line. Players' colours, titles and records are all-time, so the page always has the
whole history. How much each thing counts (the impact score's weights, titles, badges, cards, grades, milestones) comes
with the data — the page and the Discord feed compute from the same rules ([SCORING.md](SCORING.md)).

## 4. Knowing it works

A broken plugin doesn't fail loudly — numbers just stop growing. Three layers:

- **Tests** (CI on every push): every rule of [ATTRIBUTION.md](ATTRIBUTION.md), the whole collector end to end with
  every source (`test_build.py`), the parsers (world save, RCON, Steam), the page in Chromium (desktop and phone, every
  page it links to, the data loader), the chart, the plugin's event store, and every plugin hook against the game's own
  assemblies (method, arguments, fields). [events.json](events.json) is the contract: CI fails when the plugin sends an
  event that isn't listed or a listed event or `data.json` key has no test.
- **The plugin reports on itself**: hooks applied at start (`plugin` event), problems (`warn`), a per-minute sample
  (`server`), whether the crossplay session became joinable (`lobby`).
- **Runtime checks** (`health.py`, every collector run), posted to the admin webhook:
  - plugin errors, a missing or silent plugin, hours of play without combat / gathering / movement events, a stopped
    heartbeat, hooks missing, a server that can't be joined, a crash;
  - gaps in the event numbers, a replaced store, RCON unreachable;
  - cross-checks against what the plugin doesn't write: ValheimRcon's player list against sessions, the game's
    tombstones against deaths, the world save's generated zones against zone events.

The table of alerts is in the [README](../README.md#alerts).

## 5. Releases

One version for chart, images and plugin (`Chart.yaml` `version` / `appVersion`, `Plugin.cs` `Version`; CI checks
they're equal). On `main`, when every job passed, CI tags the images and the plugin with it and creates the release
`vX.Y.Z`. A Kubernetes deployment follows the release tags (Flux `GitRepository` with a semver range). The collector
alerts when the server runs a plugin of another `major.minor` than its release — so a release that needs a new plugin
bumps the minor version, one that doesn't (collector or page only) the patch.

See also: [PLUGIN-DEPLOYMENT.md](PLUGIN-DEPLOYMENT.md), [MANUAL-DEPLOYMENT.md](MANUAL-DEPLOYMENT.md),
[plugin/README.md](../plugin/README.md) (the plugin's internals).
