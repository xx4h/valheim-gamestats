# Running it without Kubernetes

The Helm chart runs two containers sharing one data directory. Anywhere else — a VM with Docker or Podman, or without
containers at all — you run the same two things yourself. A ready example is in
[`examples/standalone/`](../examples/standalone): `compose.yaml`, `config.json`, `default.conf`, `secrets.env.example`.

## What you need

- **On the game server**: the plugin and ValheimRcon — see [PLUGIN-DEPLOYMENT.md](PLUGIN-DEPLOYMENT.md).
- **The collector must reach ValheimRcon's TCP port** (default 25575): firewall open, and the collector's address in
  ValheimRcon's `Whitelist IP mask`.
- **A host for the two containers** (any Linux with Docker or Podman; ~300 MB RAM) and a reverse proxy with TLS in front
  of the web container (Caddy, Traefik, nginx …).

### What the game server's files add (optional)

The plugin and RCON are all the collector needs: sessions, deaths, combat, boss fights, gathering, zones and who
discovered them, dungeons, raids, positions, gear, live portals, Steam achievements, the Discord feed and the alerts all
come from them. The game server's files are optional and add three things:

- **the world save** (hourly): bases, chests, pets, crafted gear, signs, portals from the save, the explored map;
- **the terrain map**: drawn from the sample the plugin writes into `BepInEx/gamestats/` (not part of the save);
- **the event files while RCON is down**: the collector reads the plugin's day files instead. Without a file source it
  catches up from the event store once the server is back — nothing is lost (the store keeps 90 days).

A server's `world` block names **one** source for them (see [6. File sources](#6-file-sources)): the Pelican panel's
client API (`panel`), a directory the collector can read (`path`), or any command (`script`).

## 1. Images

Every release has both on GitHub's registry: `ghcr.io/xx4h/valheim-gamestats/{collector,web}:<version>`, public, as in
`compose.yaml`. Or build them yourself from a checkout of the release you want (no build arguments, no
network access needed beyond the base images):

```
podman build -f containers/collector/Containerfile -t valheim-gamestats-collector:1.22.2 .
podman build -f containers/web/Containerfile -t valheim-gamestats-web:1.22.2 .
```

(`docker build` takes the same arguments.) Then set `image:` in `compose.yaml` to these tags.

## 2. Configuration

The collector reads `config.json`, nginx reads `default.conf`. Both come from the chart's values, so the easiest way is
to write a values file and render them — `examples/standalone/values.yaml` is the example and
`examples/standalone/render.sh` renders it (needs `helm`; CI checks the committed example matches what the chart
renders):

```
cp -r examples/standalone /srv/gamestats && cd /srv/gamestats
```

Edit `values.yaml` (see `chart/valheim-gamestats/values.yaml` for every option), then from the repository root:

```
helm template gamestats chart/valheim-gamestats -f /srv/gamestats/values.yaml --show-only templates/configmap.yaml
```

and copy the `config.json` and `default.conf` blocks into the two files — or edit the example files directly:

**`config.json`**

| Key | |
|---|---|
| `interval` | seconds between runs (60) |
| `tz` | time zone for days, hours, the weekly recap |
| `plugin_version` | the plugin release the server should run; the `version` alert compares `major.minor` |
| `alerts.webhook_env` | the environment variable with the admins' Discord webhook |
| `servers[].id` | `[a-z0-9-]`; the data directory name and the prefix of its environment variables |
| `servers[].title` | the page's title |
| `servers[].rcon` | `host`, `port`, `password_env` — required: the events come through it |
| `servers[].world` | optional, the server's files: one of `panel` (+ `panel_host`, `gateway`, `server`), `path` or `script`; `dir`, `manifest`, `terrain`, `events`, `interval` — see [6. File sources](#6-file-sources) |
| `servers[].steam` | optional: `app` (892970), `interval` |
| `servers[].notify` | optional: `url` (links in the posts), `webhook_env` |
| `servers[].support` | optional: `url`, `label`, `text` — a support link on the page |
| `servers[].maintenance` | planned downtime, `[{"from", "to", "note"}]` (ISO 8601): not counted as down |
| `scoring`, `servers[].scoring` | optional: what counts how much, for all servers / one — [SCORING.md](SCORING.md); check with `python3 -m valheim_gamestats.scoring check config.json` |

**`default.conf`**: nginx picks the server by the `Host` header — the `map $host $gs_server` block maps each hostname
to a server id, `map $host $gs_title` gives link previews their title. Everything else stays as rendered (cache rules:
`index.json` never cached, `/c/` cached for good).

**Secrets** go into `secrets.env` (copy `secrets.env.example`, `chmod 600`), never into `config.json`. The names follow
the server id: `my-valheim` → `GS_MY_VALHEIM_…`:

| Variable | |
|---|---|
| `GS_<ID>_RCON_PASSWORD` | ValheimRcon's password — required |
| `GS_<ID>_DISCORD_WEBHOOK` | the Discord feed (with `notify`) |
| `GS_ALERTS_WEBHOOK` | the admins' alerts |
| `STEAM_API_KEY` | Steam achievements (with `steam`) |
| `PELICAN_API_KEY` | a Pelican client API key with file read permission (with `world.panel`) |

## 3. The data directory

One directory for both containers (`./data` in the example): the collector writes, nginx only reads. Both run as user
101, so:

```
mkdir -p data && sudo chown 101:101 data
```

It holds the whole history (`<id>/events.db`) — back it up. Optional extras the page uses when present:
`data/icons/valheim/` (item icons and game data, extracted from the game's files: [tools/README.md](../tools/README.md)).

## 4. Run

```
docker compose up -d
```

(or `podman compose up -d`.) The web container listens on port 8080; point the reverse proxy at it for every hostname in
`default.conf`.

**Check:**

- `docker compose logs collector` shows `[my-valheim] +N events, … sessions, … online` once a minute. `events failed:
  Connection refused` means RCON isn't reachable (address, port, firewall, whitelist); `is the plugin (1.16.0+) loaded?`
  means ValheimRcon answers but the plugin isn't there.
- `curl -H "Host: stats.example.com" http://localhost:8080/index.json` lists the data files; the page is at `/`.

## 5. Updates

Pull or build the new images, set the tags, render `config.json` again if the chart changed (its `plugin_version`
follows the release), `docker compose up -d`. The plugin is updated separately ([PLUGIN-DEPLOYMENT.md](PLUGIN-DEPLOYMENT.md));
a release that needs a new plugin has a new minor version.

## 6. File sources

All paths in `world` — `dir` (the world's save directory), `manifest` (the game's item list, for names), `terrain` and
`events` (where the plugin writes, default `BepInEx/gamestats` and `BepInEx/gamestats/events`) — are relative to the game
server's directory, or absolute. The plugin writes below its BepInEx directory wherever the server is installed; the save
of a plain install lives in the home of the user running the server, so `dir` is usually absolute there.

**Local directory** (`path`) — the collector runs on the game server's host, or the server's directory is mounted into it
(read-only is enough). In `compose.yaml`, add to the collector's volumes:

```
      - /home/valheim/valheim-server:/game:ro
      - /home/valheim/.config/unity3d/IronGate/Valheim/worlds_local:/saves:ro
```

and in `config.json`:

```
"world": {"path": "/game", "dir": "/saves/Dedicated", "manifest": "valheim_server_Data/StreamingAssets/SoftRef/manifest_extended"}
```

The collector runs as user 101: the files must be readable for it. On Kubernetes the chart mounts volumes with
`collector.extraVolumes` / `collector.extraVolumeMounts`. Relative paths can't leave `path` (`..` is refused).

**Script** (`script`) — for every other way to reach the files (SSH, rsync, an object store …). The command (a string,
split like a shell would, or a list) is run without a shell, with two more arguments:

| Call | stdout |
|---|---|
| `<command> list <directory>` | JSON, the files in the directory: `{"<name>": {"modified_at": …}}` or `[{"name": …, "modified_at": …}]` — the time as ISO 8601 or seconds since the epoch |
| `<command> get <path>` | the file's bytes |

A non-zero exit is an error (its stderr shows up in the log and the alerts); each call has 5 minutes.
[`examples/sources/ssh.sh`](../examples/sources/ssh.sh) reads the files over SSH:

```
"world": {"script": "/scripts/ssh.sh valheim@game.example.com /home/valheim/valheim-server", "dir": "/home/valheim/.config/unity3d/IronGate/Valheim/worlds_local/Dedicated", "manifest": "valheim_server_Data/StreamingAssets/SoftRef/manifest_extended"}
```

The collector image has no `ssh`: run the collector without containers, or build an image `FROM` it with `openssh-client`
and mount the key and `known_hosts`.

**Pelican** (`panel`, `panel_host`, `gateway`, `server`) — the panel's client API with a key that may read files
(`PELICAN_API_KEY`); the gateway serves the downloads the panel signs.

## Without containers

Both parts run fine on a plain host:

- **Collector**: Python 3 (the image uses 3.14; tested there), standard library only. With the secrets in the
  environment — e.g. as a systemd service with `Restart=always`:

  ```
  CONFIG=/srv/gamestats/config.json DATA_DIR=/srv/gamestats/data PYTHONPATH=collector python3 -u -m valheim_gamestats
  ```

  `--once` runs a single round (useful for a first test). Or install it — `pip install ./collector`, nothing else comes
  with it — and run `valheim-gamestats-collector`.
- **Web**: any nginx with `default.conf`; set `root` to the repository's `site/` directory instead of `/site`, and the
  `/data` paths in it to the data directory.
