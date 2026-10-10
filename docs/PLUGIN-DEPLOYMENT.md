# Deploying the plugin

The stats need the `ValheimGamestats` BepInEx plugin on the Valheim dedicated server. This is how to install it, update
it, check it and roll it back. How it works inside: [plugin/README.md](../plugin/README.md).

## Requirements on the server

| | Version used here | Notes |
|---|---|---|
| Valheim dedicated server | current | CI builds the plugin against the current public server build (its Steam build id is in each release's notes) |
| BepInExPack Valheim | 5.4.2351 | the usual BepInEx setup for Valheim (Thunderstore, or a hosting panel's "Valheim BepInEx" egg) |
| ValheimRcon | 1.6.3 | the RCON server the collector talks to (Thunderstore), `BepInEx/plugins/ValheimRcon.dll` |

**ValheimRcon** (`BepInEx/config/org.tristan.rcon.cfg`): set a password, and allow the collector's address:

```
[1. Rcon]
Port = 25575
Password = <a long random password — the collector's GS_<SERVER>_RCON_PASSWORD>
Whitelist IP mask = <the collector's address or network>, 127.0.0.1
```

**BepInEx logging** (`BepInEx/config/BepInEx.cfg`). ValheimRcon logs every command's whole reply at level `Message` —
with the collector polling every minute that's a stream of event data and Steam ids in the log. Keep `Message` out:

```
[Logging.Console]
Enabled = false
[Logging.Disk]
Enabled = true
LogLevels = Fatal, Error, Warning, Info
```

(With the console on, Unity's log lines also appear twice on stdout.)

## Getting the DLL

Each [release](https://github.com/xx4h/valheim-gamestats/releases) has the plugin attached: `ValheimGamestats.dll`.
The release notes name its sha256 and the game build it was built against:

```
curl -fsSLO https://github.com/xx4h/valheim-gamestats/releases/download/v1.22.0/ValheimGamestats.dll && sha256sum ValheimGamestats.dll
```

Or build it yourself (needs the game's reference assemblies, see [plugin/README.md](../plugin/README.md#build)):
`plugin/bin/Release/net48/ValheimGamestats.dll`.

## The one rule: never write over the loaded DLL

The running server reads method bodies from the DLL file as it first runs them. Overwriting the file in place breaks
every method not run yet (`[Gamestats] combat: Method has zero rva` in the log — on 2026-10-06 combat went unrecorded
for hours that way). Always **write the new file next to it and rename it into place**: the running server keeps the
file it has open, the new one loads at the next restart.

Also: only **one** copy in `BepInEx/plugins/`. Before 1.16.0 the plugin was `GamestatsEquipment.dll`; if both are there,
both load and every event counts twice (the collector alerts: `error:copies`).

## Kubernetes: `plugin/deploy.sh`

```
NS=<namespace> POD=<game server pod> plugin/deploy.sh 1.22.0
```

For a game server running in a pod (any image with BepInEx, e.g. a hosting panel's). It downloads the release from
GitHub, keeps the current DLL as
`BepInEx/gamestats-plugin.dll.bak`, writes the new one to `BepInEx/ValheimGamestats.dll.next`, renames it to
`BepInEx/plugins/ValheimGamestats.dll`, removes an old `GamestatsEquipment.dll`, and checks the checksum and that
`plugins/` has exactly one copy. `CONTAINER` (default `game`) and `ROOT` (default `/home/container`) can be set. Without a
version it deploys the local build.

## Any other server: by hand

On the server's machine, with the server directory as `$ROOT` (the directory with `BepInEx/` in it):

```
cp ValheimGamestats.dll "$ROOT/BepInEx/ValheimGamestats.dll.next"
cp "$ROOT/BepInEx/plugins/ValheimGamestats.dll" "$ROOT/BepInEx/gamestats-plugin.dll.bak" 2>/dev/null; true
mv "$ROOT/BepInEx/ValheimGamestats.dll.next" "$ROOT/BepInEx/plugins/ValheimGamestats.dll"
rm -f "$ROOT/BepInEx/plugins/GamestatsEquipment.dll"
sha256sum "$ROOT/BepInEx/plugins/ValheimGamestats.dll"
```

The `.next` file sits outside `plugins/` (BepInEx would load it as a second copy) but on the same filesystem, so `mv` is
a rename, not a copy. **Windows** keeps loaded DLLs locked: there, stop the server first, then copy.

## Restart, then check

The new plugin loads at the next restart. Afterwards:

- `BepInEx/LogOutput.log` lists `Loading [Valheim Gamestats <version>]` once, and no `[Gamestats] <area>:` warnings.
- `BepInEx/gamestats/events/<today>.jsonl` gets a `plugin` event with `"hooks":N,"of":N,"failed":[]` — every hook
  applied — then `start` and, once a minute, `server`.
- With crossplay on: a `lobby` event `"i":"active"` within seconds of `start`.
- The collector's log: `+N events` again after the restart; the version alert (if any) resolves.
- Flag the restart as planned maintenance (`servers[].maintenance` in the chart values), so the page doesn't count it
  as downtime.

## Settings

`BepInEx/config/valheim.gamestats.cfg` (written on first start):

| Setting | Default | |
|---|---|---|
| `[Debug] Diag` | `false` | diagnostic lines (`[Gamestats-diag]`) in the server log |
| `[Debug] EventsToLog` | `false` | every event in the server log too, as before 1.18.0 |
| `[Debug] Trace` | `false` | record what the combat logic sees to `BepInEx/gamestats/trace/<UTC day>.jsonl` — a few MB per session with fights; replay it with `cd tests/plugin && dotnet run -- replay <file>` (see `plugin/CombatTrace.cs`). For a session or two, then off again |

## Rolling back

Deploy the previous release the same way (`deploy.sh <older version>`), or rename `BepInEx/gamestats-plugin.dll.bak`
back into `plugins/` — again next to, then into place — and restart. The event store is kept; its numbers continue.

## After a Valheim update

The server keeps running with the plugin; a hook the update broke switches itself off (`warn` `patch`, the collector
alerts `hooks`) and the rest keeps working. CI always builds against the current public server (SteamCMD), so the next
push checks every hook against the new game: fix what it names, release, deploy. Locally: `plugin/fetch-refs.sh` updates
the game in its cache, then build and run `tests/plugin`.
