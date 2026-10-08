#!/bin/sh
# Renders config.json and default.conf for the standalone example from the chart (needs helm). Run from the repo root.
set -eu
DIR=examples/standalone
OUT=$(helm template gamestats chart/valheim-gamestats -f "$DIR/values.yaml" --show-only templates/configmap.yaml)
printf '%s\n' "$OUT" | awk '/^  config.json: \|/{f=1; next} /^  [a-z.]+: \|/{f=0} f' | sed 's/^    //' > "$DIR/config.json"
printf '%s\n' "$OUT" | awk '/^  default.conf: \|/{f=1; next} /^  [a-z.]+: \|/{f=0} f' | sed 's/^    //' > "$DIR/default.conf"
