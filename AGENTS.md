# Working on valheim-gamestats

Instructions for coding agents (and people). How the system works: [docs/DESIGN.md](docs/DESIGN.md).

## Layout

| Path | What | Language |
|---|---|---|
| `plugin/` | the BepInEx plugin on the game server: hooks → events in its own store, RCON commands | C# (net48, Harmony) |
| `collector/` | the `valheim_gamestats` package: fetches events, the world save, RCON state, Steam; builds the data and its pieces; alerts; Discord feed (`pyproject.toml`: metadata and ruff) | Python ≥ 3.12, **standard library only** |
| `site/` | the static page (`index.html`, `app.js`, `style.css`) | plain JS, no build step |
| `chart/valheim-gamestats/` | Helm chart: both containers, nginx config, collector config — every setup detail is a value | Helm |
| `containers/` | Containerfiles for the collector and web images | |
| `docs/` | design, deployment, [who gets credit](docs/ATTRIBUTION.md), [what counts how much](docs/SCORING.md), [the event contract](docs/events.json) | |
| `tests/collector/`, `tests/site/`, `tests/chart/`, `tests/plugin/` | the tests CI runs | |
| `demo/` | the demo: a made-up server played through the real collector (`generate.py`, published to GitHub Pages), the README's animation (`showcase.sh`, made by the Pages workflow) | Python, JS |
| `examples/sources/` | file source scripts for `world.script` (`ssh.sh`) | sh |
| `examples/standalone/` | compose setup without Kubernetes (rendered from the chart, kept in sync by `tests/chart/check.sh`) | |
| `tools/` | one-off extractors for item icons and player looks (run by hand after game updates) | Python |

## Checks — run the ones for what you changed

```
python3 -m unittest discover -s tests/collector -v
ruff check --config collector/pyproject.toml collector tests/collector tools demo
cd tests/site && npm ci && npx playwright test
tests/chart/check.sh
cd plugin && dotnet build -c Release -warnaserror
cd tests/plugin && dotnet run
cd tests/plugin && dotnet run -- replay <trace.jsonl>   # a recorded session (plugin config Debug/Trace) through CombatCore
cd tests/plugin && dotnet run -- expect                 # rewrite tests/combat/*.expected.json from CombatCore (after a rule change)
python3 tools/combat_fixture.py <trace> <out.jsonl.gz> [from] [to]   # a recorded fight → an anonymised fixture for tests/combat
```

- CI runs the collector tests on Python 3.12 (the oldest it supports) and 3.14 (its image), the latter with coverage —
  it fails below 90 %. New collector code comes with tests; `ruff` must pass (no `ruff format`: the code isn't
  formatter-shaped, fix what the linter names).
- The site tests need Chromium (Playwright) and `python3` (they split the fixture with
  `valheim_gamestats.chunks`). In a container: `mcr.microsoft.com/playwright:v1.63.0-noble`, the same as CI.
- The plugin build and `tests/plugin` (the event store, and every hook checked against the game's assemblies) need the
  game's reference DLLs in `plugin/lib/` — proprietary, never committed: `plugin/fetch-refs.sh` fetches them from
  their public sources (the dedicated server through SteamCMD, BepInEx and ValheimRcon from Thunderstore), as CI does,
  or with `--pod` from a running server.
- `tests/chart/check.sh` needs `helm`.
- On NixOS, run tools through nix: `nix run nixpkgs#python3 -- -m unittest …`, `nix shell nixpkgs#dotnet-sdk_8 -c …`.

## Rules

- **The combat rules exist twice**: `plugin/CombatCore.cs` (the plugin's results) and `collector/valheim_gamestats/combat.py`
  (the collector's, from the plugin's facts — what the page shows where facts exist). A rule change goes into both, line
  for line, with `combat.RULES` bumped (the collector recomputes everything) and `tests/combat/*.expected.json`
  rewritten (`dotnet run -- expect`); `tests/plugin` and `tests/collector/test_combat.py` both check them. New fixtures
  come from `tools/combat_fixture.py`, with invented names — never a real player's.

- **A new event or `data.json` key goes into [docs/events.json](docs/events.json) first**, with its tests.
  `test_contract.py` fails when the plugin sends an event that isn't listed, or an entry has no test about it;
  `test_build.py` fails when `data.json` has a key the contract doesn't know. A new stat that credits players gets a
  row in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) and a test named after the rule.
- **"Online at the time" is never credit.** Credit goes to who did it or who was there (see ATTRIBUTION.md).
- **How much something counts lives in `collector/valheim_gamestats/scoring.json` only** (impact weights, titles and
  their minimums and texts, badges, cards, traits, grades, milestones): the page and the Discord feed read it from the
  data, servers override it ([docs/SCORING.md](docs/SCORING.md)). Code keeps only how a thing is measured and how its
  value reads. After changing `scoring.json`'s shape, regenerate the chart schema:
  `python3 -m valheim_gamestats.scoring schema > chart/valheim-gamestats/values.schema.json`.
- **The collector stays standard-library Python** (`dependencies = []` in `collector/pyproject.toml`; test-only tools
  like coverage and ruff are fine in CI). Modules import each other relatively (`from . import events`). No build step
  for the site.
- **No setup specifics in the repository**: hostnames, server ids, names, links are chart values. Fixtures and examples
  use invented names (Ragnar, Astrid, Bjorn …); `tests/site/anonymize.py` makes the site fixture from real data.
- **Never commit** secrets, the game's DLLs (`plugin/lib/`), build output (`bin/`, `obj/`) or real player data.
- **Plugin hooks**: one class per `[HarmonyPatch]`; they're applied one by one, so a broken one switches only itself off.
  Hooks must not change what the game does (report, don't fix — a `Finalizer` returns the exception). Anything that can
  throw inside a hook goes in `try`/`catch` → `Events.Warn(area, message)`. CI checks every hook's target method,
  argument names and `___field` names against the game.
- **Plugin deployment**: never overwrite the DLL a running server has loaded — stage it next to `plugins/` and rename
  it into place (`plugin/deploy.sh`, [docs/PLUGIN-DEPLOYMENT.md](docs/PLUGIN-DEPLOYMENT.md)). A new plugin only loads
  with a server restart; restarts are the server owner's call.
- **Golden data**: `tests/collector/golden/data.json` is the whole collector's output for a made-up scenario. A diff is
  a change in what the page gets: understand it, then accept it with `UPDATE_GOLDEN=1` and review the diff.
- **Sidebar shortcuts** (`g` then a key): an entry gets the first letter of its sidebar name that's still free — its
  second, third, … letter when an earlier one is taken — and entries pick in order of importance, so the more important
  of two with the same letter keeps it. The keys are computed from `GO_ORDER` in `site/app.js`: a new sidebar entry goes
  in there at its importance, never with a hand-picked key.
- **Shell snippets** in docs and scripts are real one-liners: no `\` line continuations.

## Versions and releases

- One version for chart, images, collector and plugin: `chart/valheim-gamestats/Chart.yaml` (`version`, `appVersion`),
  `collector/valheim_gamestats/__init__.py` (`__version__`) and `plugin/Plugin.cs` (`Version`) — the `versions` job
  fails if they differ. Also bump `pluginVersion` in
  `tests/chart/full-values.yaml` and the expected value in `tests/chart/check.sh`.
- **Patch** (1.20.x) when the plugin doesn't need to change on the server (collector, page, chart). **Minor** when it
  does: the collector alerts (`version`) until a server runs the same `major.minor`, which needs a restart.
- Merging to `main` with every job green makes CI tag the images and the plugin and create the release `vX.Y.Z`;
  deployments follow those tags. Never tag by hand.

## Commits

Conventional subject (`feat:`, `fix:`, `ci:`, `docs:`, `test:`, `build:`), ≤ 75 characters, saying what and why; a body
only for what isn't obvious. Commits carry `Signed-off-by:` (`git commit -s`).
