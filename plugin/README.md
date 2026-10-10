# ValheimGamestats

BepInEx plugin for a Valheim dedicated server (`ValheimGamestats.dll`, GUID
`valheim.gamestats`; `GamestatsEquipment.dll` before 1.16.0). It records what
the game doesn't log — combat, gathering, movement, who discovered a zone, … —
and adds RCON commands to ValheimRcon, each answering JSON; the gamestats
collector (`../collector/valheim_gamestats/rcon.py`) polls them every minute.

## Events: its own store, not the server log

Since 1.16.0 every event goes to the plugin's own store on the server's disk
(`EventStore.cs`): one JSON object per line in
`BepInEx/gamestats/events/<UTC day>.jsonl`, numbered and timed —

    {"s":1234,"t":1791370829290,"e":"kill","p":"Ragnar","i":"Troll","n":1}

The files live on the server's volume, so a restart, a crash or a collector
that didn't come by loses nothing; the collector asks for what came after the
last number it has (RCON `gs_events <after>`: a header line
`{"id":…,"head":…,"oldest":…}`, then as many events as fit in ValheimRcon's
~4 KB reply) and asks again until none come. A gap in the numbers is exactly
what's missing; a new `id` means a new store (numbers start over). 90 days of
files are kept (about 300 KB a day). A line torn by a crash is skipped. An event
that couldn't fit into one reply is refused and gets no number — a reply could
never carry it, and the collector would ask for it forever; a `warn` event
(`events`, "too big: …") takes its place for the collector's alert.
`tests/plugin` runs the store outside the game.

Since 1.17.0 the store also has everything the collector used to read from
the game's own log (`Server.cs`), so in the end it needs nothing from the
server log at all — only in the store, never in the log:

| Event | When | Fields |
|---|---|---|
| `start` | the world is up | `i` world, `game` Valheim version, `backend` PlayFab (crossplay) or Steamworks (1.20.0) |
| `lobby` | the crossplay session became joinable, or PlayFab failed (1.20.0) | `i` `active` / `failed`, `code` join code, `msg` |
| `stop` | clean shutdown (a crash leaves none) | |
| `login` | a connection's first character | `p`, `i` platform id (`Steam_…`), `uid` |
| `spawn` | every character, respawns too | `p`, `uid` |
| `death` | the character is gone (the game's `… : 0:0`) | `p`, `uid`, `x`, `z` |
| `logout` | disconnected | `p`, `uid` |
| `raid` / `raidend` | a random event starts / ends | `i` event, `x`, `z`, `near`: players in its range |
| `sleep` | everyone slept | `time` world time now, `to` the morning it skips to |
| `server` | once a minute | `n` connections, `zdos` world objects, `time` world time |
| `warn` | a problem (also in the log), once a minute per area | `i` area, `msg` |

`zone` carries the location placed in it (`l`), which the game's log said in a
line of its own. A second copy of the plugin under the old name
(`GamestatsEquipment.dll`) is reported as `warn` `copies`.

Every hook is applied on its own: if a game update breaks one, that one is
off (`warn` `patch`), the rest keeps working. Since 1.19.0 the `plugin` event at
start says how it went — `"hooks": 12, "of": 12, "failed": []` — and the
collector alerts (`hooks`) when one is missing. CI checks every hook against the
game's assemblies before that can happen (`tests/plugin/Patches.cs`: the
patched method, its arguments and the fields a hook reads).

Since 1.18.0 the events are not in the server log (1.16–1.17 wrote both while
the collector moved over). What stays in the log, for people reading it: the
plugin's start line and its warnings (`[Gamestats] <area>: …`; those are also
in the store as `warn` events, which is what the collector reads). In
`BepInEx/config/valheim.gamestats.cfg`: `EventsToLog = true` puts every event
in the log again, `Diag = true` adds diagnostic lines (`[Gamestats-diag]`).

ValheimRcon logs every command's reply at level `Message`. Keep `Message` out of
BepInEx's log levels (`BepInEx.cfg`: `[Logging.Disk] LogLevels`, and the console
disabled), or the replies end up in the logs instead.

## RCON commands

- `equipment` — the visible gear of every connected player (item per slot;
  quality only for hand, back and cape items — the game syncs nothing more).
- `tombstones` — the levelled, equippable items in every tombstone. A
  tombstone is a dead player's whole inventory with exact levels, so the
  collector uses the newest one as "level at last death" for armor, utility
  and trinket. Newest first, oldest dropped to stay under ValheimRcon's ~4 KB.

It also logs **who picked up, felled and mined what** (`Gather.cs`): a Harmony
hook on the server's `ZDOMan.RPC_DestroyZDO` sees every deletion a client
reports, while the object's data is still there. Hits and picks themselves
often never reach the server (clients run them locally on objects they own),
deletions always do. Picked-up items are credited to the deleting client
(picking up takes ownership first) if it stands ≤8 m away; felled trees and
mined rocks/ore deposits to the nearest player within 15 m. Since 1.11.0 only
first pickups count: an item that has been in any inventory before (its
`m_pickedUp` flag — dropped by a player, or crafted) is skipped. `Loot.cs`
adds `loot`: what a player took out of a world container (dungeon, treasure,
shipwreck chests — no creator), seen as the container's items shrinking in a
`ZDO.Deserialize` from its owner (the opener), again only items nobody has
held yet. Summed per minute and logged to stdout, one line per (event,
player, object):

    [Gamestats] {"e":"pick","p":"Ragnar","i":"Wood","n":37}

`Custody.cs` (since 1.12.0) follows gear — equippable, unstackable items
(weapons, tools, armor, capes, utility, trinkets; not torches) — so the page
can say who has an item that is missing from its place. Inventories never
reach the server, but every way out of a shared place does: `take` / `put`
when a container's contents change (credited to its owner, i.e. the opener;
fresh world loot appearing is not a `put`), `off` / `on` for item and armor
stands (the nearest player within 8 m), and `carry` for every pickup of such
an item from the ground (Gather.cs). Copies are told apart by crafter and
quality. Not summed, one line per move with the place:

    [Gamestats] {"e":"take","p":"Ragnar","i":"AxeBlackMetal","q":3,"c":"Astrid","k":"chest","x":120,"z":-460,"n":1}

(`k`: `chest`, `world chest`, `tombstone`, `stand` or `ground`.)

`Dungeons.cs` (since 1.13.0) logs who went into which dungeon. The game
builds a dungeon's interior about 5000 m up, straight above its entrance, so a
character above 3000 m is inside one, and the location placed nearest below is
the way in. Checked every 2 s; `enter` when someone goes up, `leave` with the
seconds inside when they come down or disconnect. `x` / `z` are the entrance's:

    [Gamestats] {"e":"enter","p":"Ragnar","i":"Crypt3","x":-1234,"z":567,"n":1}
    [Gamestats] {"e":"leave","p":"Ragnar","i":"Crypt3","x":-1234,"z":567,"n":1,"s":412}

`Zones.cs` (since 1.15.0) logs who discovered each zone. The server
generates the zones around every connected player, within the simulation
distance, so when a zone becomes generated (`ZoneSystem.SetZoneGenerated`, only
for new zones — loading a save fills the list directly) the players whose
position is within that distance are the ones involved: the explorer, or a
group exploring together — not everyone online elsewhere. Every zone, also the
ones without a location (the game's own log names only those with one):

    [Gamestats] {"e":"zone","p":"","i":"12,-90","n":1,"by":["Ragnar"]}

`Portals.cs` (since 1.14.0) adds the RCON command `portals`: every portal with
its tag, position and the portal the game has actually linked it to,
`[["tag",x,z,partner],…]` (partner = index in the list, -1 for none). The game
pairs portals itself every few seconds — two with the same tag, untagged ones
too; a third with a tag stays unlinked — and the world save only says which
share a tag, so this is what the page shows as linked. The collector polls it
every minute with the other commands.

`Vitals.cs` (since 1.14.0) samples every online player once a second from
what their client syncs on the character — position, health, max health,
stamina, eitr, in bed, emotes, the crouching animator flag:

- summed per minute like the gather lines: `dist` (`i` = `foot`, `swim`,
  `boat`, `ride`: metres; portal jumps and dungeon interiors left out),
  `crouch` (seconds), `exh` / `exhn` (seconds without stamina / times it ran
  out), `emote` (`i` = the emote), `bed` (lay down in a bed at night);
- the highest value per minute as `peak` (`i` = `hp`, `st`, `eitr`, `y` —
  metres above sea level, `v_foot` … `v_ride` — top speed in m/s, `hit` — the
  biggest single hit survived, from `Combat.cs`);
- single events: `sprint` (`m`, `s`: on foot faster than jogging, start to
  stop, ≥ 5 s), `closecall` (`hp`, `max`: below 10 % of max health and back
  above half, alive), `fall` (`h`: fell ≥ 8 m fast and straight down onto
  land, alive 5 s later).

Swimming and sailing are told apart by the water level (30 m) and the world's
base terrain height, riding by a saddled tamed Lox or Asksvin at the player.

    [Gamestats] {"e":"dist","p":"Ragnar","i":"foot","n":412}
    [Gamestats] {"e":"peak","p":"Ragnar","i":"hp","n":187.5}
    [Gamestats] {"e":"sprint","p":"Ragnar","n":1,"m":214.3,"s":31}

`Combat.cs` adds kills and damage the same way, from synced state rather
than hit events: a hook on `ZDO.Deserialize` compares character health
(`ZDOVars.s_health`) before and after every update the server receives — a
mob's loss is damage dealt by the players in its attacker list
(`ZDOVars.s_attackers` + name) who are alive and within 60 m. Which of them
gets how much comes from `Attacks.cs`: every attack starts with an animation
trigger that passes through the server, matched against the attack animations
of what the player holds. A health drop goes to its cause: a routed hit
just before it (a player's or a summon's: exact), the fire / spirit / poison
ticks of such a hit (from its budget), else the client that runs the creature —
its player's damaging attacks in the 3 s before it and its summons' in reach;
nothing of that is `udmg`, unattributed (docs/ATTRIBUTION.md). Summons and commanded tames
never get on the attacker list; their attack triggers (with their follow
target) count for that player, under the summon's name, when the summon was in
reach of the mob (one creature per attack), and a summon's hit in the 10 s
before a death makes its player a killer. A player's loss is damage
and one hit taken (a clamp to a lower max health when food wears off is
skipped), except the cost of their own blood magic: a health-cost attack takes
(flat + health × percent) × (1 − 0.33 × skill factor) in its first frame, so a
drop in that range right after its trigger is `cost` (health paid), and a
bigger one is the cost plus a hit merged into the same sync. A mob deleted with health ≤ 0 is a kill for every attacker (taken
when its health hit 0, so someone who dies right after still counts); its
name carries the stars (`Troll*1`). One-hit kills are deleted before their
last state syncs, so the ragdoll every death spawns (a networked object) is
the second signal: a ragdoll without a counted death of a kind it belongs to
(several kinds can share one) nearby is a kill for the
attackers the server knows, with the mob's last known health as damage. Every
death is credited 3 s after it to its attacker list's players plus those the
other evidence names: the game's kill note (`RPC_RegisterKill`, routed by the
server), a routed hit of theirs (`RPC_Damage`), their own damaging attack just
before in reach of it (one attack for one death). A death with no evidence for
its killer is never guessed from who is near: it's an
unaccounted kill (`ukill`, no player; a `[Gamestats-unaccounted]` line in the
server log; docs/ATTRIBUTION.md). Creatures without a ragdoll (Seekers, Ticks,
Blobs, bosses …) drop their loot at death instead: one deleted with health left
is a kill when its own loot (its drop table, created by the client that
deleted it, within 3 m and 2 s) appears — not one deleted on a timer (enemy
summons). A deletion right after damage that no signal explains is `gone`
(trace only for now). Damage and kills are also logged per
weapon: the one attacked with, else the one held (bows and other left-hand
weapons, else the right hand, else `Unarmed`). Events: `pick`, `fell`, `mine`, `kill`, `wkill`,
`dmg`, `wdmg`, `taken`, `hit`, `loot`, `take` / `put` / `off` / `on` / `carry`,
`enter` / `leave`, `zone`, `dist`, `crouch`, `exh` / `exhn`, `emote`, `bed`, `peak`,
`sprint`, `closecall`, `fall`, and `dw` / `kw` (damage / kills per `Weapon>Creature`).

The combat rules are `CombatCore.cs`, without game types: `Combat.cs` only reads the game's state and hands it over.
`tests/plugin` pins every rule as a scenario (the known gaps included, marked as such), and with `[Debug] Trace` on the
plugin records everything the core is told (`CombatTrace.cs`), so a real session can be replayed through it offline:
`dotnet run -- replay <trace.jsonl>` in `tests/plugin` shows what today's rules make of it next to what the plugin made
of it then, checks it against the rules' invariants and prints the coverage per creature (docs/ATTRIBUTION.md, "Checks").

Tamed creatures are not combat (since 1.8.0): hitting or butchering a pet counts
as neither damage dealt nor a kill. `Pets.cs` logs the death of every tamed creature (one `petdeath` line, not
summed): its identity (prefab + BaseAI's `spawntime`, the key the collector
also reads from the world save), where, the players in its attacker list, and
the nearest untamed creature within 30 m as the likely killer — the server is
never told which creature hit it. Young deleted with health left grew up, and
summons (`*_Summoned`) expire; neither is logged. Since 1.7.0 it also logs each
pet's health history, one `pethp` line per pet and minute with any change:
damage, hits, healing, lowest health, and damage by source (a player who hit
it, else `~` + the nearest creature around as a guess, else `?`).

`Terrain.cs` (since 1.10.0) samples the whole world once per seed for the
map page's terrain: biome and height on a 2048 × 2048 grid (~10 m apart)
straight from the game's `WorldGenerator`, on a background thread about a
minute after the world has loaded. It writes
`BepInEx/gamestats/terrain-<seed>.bin.gz` plus `terrain.json` naming it, and
skips the work when that file exists — so a restart costs nothing, and a new
world gets its own file. The collector (`../collector/valheim_gamestats/mapimg.py`) fetches it
through the server's file source and draws `terrain.png`; the page only shows it where
players have been. `BepInEx/LogOutput.log` says
`[Gamestats terrain] 2048x2048 samples in …s`.

The collector reads these from the plugin's store like every other event
(`gather` in data.json → Collected / Felled / Mined / Kills / Dmg dealt /
Dmg taken / Hits taken on the leaderboard).

## Build

The game, BepInEx and ValheimRcon assemblies are proprietary and not
committed. `fetch-refs.sh` gets them from their public sources — the dedicated
server through SteamCMD (anonymous), BepInExPack Valheim and ValheimRcon from
Thunderstore — the way CI does; `--pod` copies them from a running server
instead:

    ./fetch-refs.sh
    NS=<namespace> POD=<game pod> ./fetch-refs.sh --pod

    nix shell nixpkgs#dotnet-sdk_8 -c dotnet build -c Release

Output: `bin/Release/net48/ValheimGamestats.dll`. Releases are built by CI
and attached to the GitHub release as `ValheimGamestats.dll`.
The plugin's `Version` (Plugin.cs) is the release version, the same as in
`chart/valheim-gamestats/Chart.yaml` — CI fails if they differ, and the
collector alerts when a server runs another one than its release ships.

## Deploy

Installing, updating, checking and rolling back on a server: [docs/PLUGIN-DEPLOYMENT.md](../docs/PLUGIN-DEPLOYMENT.md).

Never write over the DLL the running server has loaded: Mono reads method
bodies from that file as it first runs them, so everything not run yet breaks
(`[Gamestats] combat: Method has zero rva` in the game log — on 2026-10-06
combat went unrecorded for hours this way). `deploy.sh` stages the new file
outside `plugins/` (BepInEx would load a second copy there), renames it into
place and checks it arrived intact; the running server keeps the file it has
open:

    NS=<namespace> POD=<game pod> ./deploy.sh 1.21.0    # a release
    NS=<namespace> POD=<game pod> ./deploy.sh            # the local build

Then restart the server. `BepInEx/LogOutput.log` should list
`Loading [Valheim Gamestats <version>]` and `Registered command gs_events`.
`deploy.sh` also removes `GamestatsEquipment.dll` (the name before 1.16.0):
two copies in `plugins/` would both load and count every event twice (the
collector alerts: `duplicate`).

## After a Valheim update

If the game renames a `ZDOVars` field, the plugin fails to load (ValheimRcon
keeps working, the page just stops updating; the collector's health check
alerts: `noplugin`). CI builds against the current public server on every
push, so it names what broke; locally `./fetch-refs.sh` brings the game up to
date. Fix what the compiler and `tests/plugin` name, release, redeploy.
