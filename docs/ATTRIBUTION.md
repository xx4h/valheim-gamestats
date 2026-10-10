# Who gets credit for what

(How much each thing then counts — weights, titles, badges — is a server's own choice: [SCORING.md](SCORING.md). Who
gets the credit isn't.)

Every number on the page belongs to someone. This is the rule for each one, and
where it comes from. **A new stat needs a row here first**, and every rule has a
test in `tests/collector/` named after it (`test_session_…`, `test_zone_…`,
`test_kill_…`, …). "Online at the time" is
never enough on its own: a player is credited for what they did or where they
were, not for being connected while someone else did it.

Sources: **plugin** = the plugin's events (its own store on the server), **save** =
the world save, **rcon** = the plugin's and ValheimRcon's RCON commands; **log** =
history from before plugin 1.17.0, when sessions, deaths, raids and locations came
from the game server's own log (imported once, see `collector/valheim_gamestats/events.py`).

Rules from the **plugin** are decided inside the game server (who stood where,
who attacked when) and can't run outside the game. For those the tests check that
the collector credits exactly whom the plugin's line names, no one more, and
`collector/valheim_gamestats/health.py` alerts when the lines stop coming.

## Time & presence

| Stat | Credited to | Source |
|---|---|---|
| Session, playtime | the player whose character spawned, until they disconnect (or the server stops / goes silent) | plugin ≥ 1.17.0 (log before) |
| Death | the player whose character was destroyed | plugin ≥ 1.17.0 (log before) |
| Raid | everyone online when it started — a raid hits the server, the player list is context, not credit (`near`: who was within its range, since 1.17.0) | plugin ≥ 1.17.0 (log before) |

## Exploration

| Stat | Credited to | Source |
|---|---|---|
| Zone discovered | the players within the server's generation distance of the zone when it was generated (plugin `zone`) — the explorer, or a group exploring together; never someone elsewhere | plugin ≥ 1.15.0 |
| Zone discovered, before plugin 1.15.0 | everyone online when the log named it (`exact` missing; the page says so) | log |
| Dungeon entered | the player whose character went into the interior, at that entrance | plugin ≥ 1.13.0 |

## Combat

| Stat | Credited to | Source |
|---|---|---|
| Damage dealt | players in the mob's attacker list who attacked within 3 s before the health drop, alive and within 60 m; one share per attack, else split evenly | plugin |
| Kill | every attacker of a mob that died with health ≤ 0 (alive, within 60 m); a one-hit kill seen only as a ragdoll: its known attackers, else the nearest player within 15 m | plugin |
| Damage / hits taken | the player whose health dropped (not a drop to a new, lower max health: food wearing off; not the cost of their own blood magic) | plugin |
| Health paid | the player whose own health-cost attack (Dead Raiser, Staff of Protection, Trollstav …) took it: the drop right after its trigger, from a third less (blood magic skill) up to the full cost; a hit in the same sync is the rest, as damage taken | plugin |
| Pet killed | never a kill or damage dealt; recorded as the pet's death | plugin ≥ 1.8.0 |

### Checks

Every combat rule keeps these, in group fights as much as alone:

- **I1 Evidence per player.** Damage or a kill only from evidence tied to that player: their own attacks, their place
  on the creature's attacker list, their summons. Never from being nearby alone.
- **I2 One attack, one target**, unless the attack really hits several (area attacks: fireballs, bombs, atgeir spins).
- **I3 Each death once**, however many signals report it.
- **I4 A correction of a player's own numbers looks only at that player.**
- **I5 Ambiguity stays visible**: what the evidence can't decide between players is split and counted as estimated,
  not handed to one of them.

The plugin's combat rules (`plugin/CombatCore.cs`) have a scenario test for each rule, in solo and group situations
(`tests/plugin`). With `[Debug] Trace` on, the plugin records everything those rules are told; `dotnet run -- replay
<trace.jsonl>` in `tests/plugin` replays a real session through today's rules, checks I1 and I3 on it, and prints per
creature how much of the health it lost was credited to players (coverage).

## Gathering & items

| Stat | Credited to | Source |
|---|---|---|
| Picked up | the client that deleted the item, standing within 8 m; only items nobody held before | plugin ≥ 1.11.0 |
| Felled / mined | the nearest player within 15 m of the tree or rock | plugin |
| Looted (world chests) | the owner of the container (the opener) for items that left it and nobody had held | plugin ≥ 1.11.0 |
| Crafted (in chests) | the crafter name the game stores on the item | save |
| Built | the creator stored on the piece | save |
| Chests' contents | nobody — a chest's builder doesn't own what others put in | save |
| Gear moved (who has it) | the container's owner (opener) for chests, the nearest player within 8 m for stands, the picker for the ground | plugin ≥ 1.12.0 |

## Body & movement

| Stat | Credited to | Source |
|---|---|---|
| Distance, top speed, highest point, sprint, fall, close call, max health / stamina / eitr, emotes, crouching, beds | the player whose own character's synced state it is | plugin ≥ 1.14.0 |
| Biggest hit survived | the player whose health dropped | plugin ≥ 1.14.0 |

## Never

- Anything for being online while someone else did it — except raids, which are about the server.
- Anything twice: one event, one credit per player (a group shares, it doesn't multiply).
- Silent gaps: if the plugin stops sending (an error, a broken deploy), that is an alert, not zeroes (the runtime
  checks in `collector/valheim_gamestats/health.py`).
