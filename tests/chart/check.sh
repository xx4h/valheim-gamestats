#!/bin/sh
# The chart renders with no values and with every option (full-values.yaml), and the collector's config says what
# the values say.
set -eu
CHART=chart/valheim-gamestats
helm lint --strict "$CHART"
helm lint --strict "$CHART" -f tests/chart/full-values.yaml
helm template t "$CHART" > /dev/null
OUT=$(helm template t "$CHART" -f tests/chart/full-values.yaml)
for want in '"plugin_version": "1.22.1"' '"webhook_env": "GS_ALERTS_WEBHOOK"' '"webhook_env": "GS_FIRST_DISCORD_WEBHOOK"' '"password_env": "GS_FIRST_RCON_PASSWORD"' '"panel_host": "panel.example.com"' 'www.stats.example.com first;' 'second.example.com second;' 'key: first-rcon' 'key: alerts-discord-webhook' 'claimName: stats-data' 'secretName: www.stats.example.com-tls' 'location ^~ /c/' 'immutable' '"path": "/game"' '"events": "custom/BepInEx/gamestats/events"' 'claimName: valheim-server' 'mountPath: /game' '"ragequit": {' '"built": 30' '"steps": ['; do
  printf '%s\n' "$OUT" | grep -qF "$want" || { echo "missing in the rendered chart: $want"; exit 1; }
done
# a server id that isn't a DNS-ish name fails, instead of rendering a broken env var
if helm template t "$CHART" --set 'servers[0].id=Bad_Id' --set 'servers[0].rcon.host=x' > /dev/null 2>&1; then echo "bad server id accepted"; exit 1; fi
# the standalone example (docs/MANUAL-DEPLOYMENT.md) is what the chart renders (plugin_version follows the release)
D=examples/standalone
OUT=$(helm template gamestats "$CHART" -f "$D/values.yaml" --show-only templates/configmap.yaml)
printf '%s\n' "$OUT" | awk '/^  config.json: \|/{f=1; next} /^  [a-z.]+: \|/{f=0} f' | sed 's/^    //' | grep -v plugin_version > /tmp/config.json
printf '%s\n' "$OUT" | awk '/^  default.conf: \|/{f=1; next} /^  [a-z.]+: \|/{f=0} f' | sed 's/^    //' > /tmp/default.conf
grep -v plugin_version "$D/config.json" | diff -u - /tmp/config.json || { echo "examples/standalone/config.json is stale: run examples/standalone/render.sh"; exit 1; }
diff -u "$D/default.conf" /tmp/default.conf || { echo "examples/standalone/default.conf is stale: run examples/standalone/render.sh"; exit 1; }
# a world block names exactly one file source
if helm template t "$CHART" --set 'servers[0].id=x' --set 'servers[0].rcon.host=h' --set 'servers[0].world.dir=d' > /dev/null 2>&1; then echo "world without a source accepted"; exit 1; fi
if helm template t "$CHART" --set 'servers[0].id=x' --set 'servers[0].rcon.host=h' --set 'servers[0].world.path=/a' --set 'servers[0].world.script=b' > /dev/null 2>&1; then echo "world with two sources accepted"; exit 1; fi
# scoring overrides are checked against values.schema.json (made by valheim_gamestats.scoring): a typo fails here
if helm template t "$CHART" --set 'scoring.titles.marthon.min=1' > /dev/null 2>&1; then echo "unknown title accepted"; exit 1; fi
if helm template t "$CHART" --set 'servers[0].id=x' --set 'servers[0].rcon.host=h' --set 'servers[0].scoring.impact.bonus.built=-1' > /dev/null 2>&1; then echo "negative weight accepted"; exit 1; fi
# a server without RCON fails: the plugin's events come through it
if helm template t "$CHART" --set 'servers[0].id=x' > /dev/null 2>&1; then echo "server without rcon accepted"; exit 1; fi
echo ok
