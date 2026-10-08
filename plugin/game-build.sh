#!/usr/bin/env bash
# The Steam build id of the current public Valheim dedicated server (app 896660), without downloading it: what CI keys
# its download cache by and what the daily game check (.github/workflows/game.yml) compares with the last tested one.
# Needs steamcmd, or podman/docker for the steamcmd/steamcmd image.
set -euo pipefail
args=(+login anonymous +app_info_update 1 +app_info_print 896660 +quit)
for try in 1 2 3; do
  if command -v steamcmd >/dev/null; then out=$(steamcmd "${args[@]}" 2>/dev/null || true)
  else
    run=$(command -v podman || command -v docker) || { echo "need steamcmd, podman or docker" >&2; exit 1; }
    out=$("$run" run --rm docker.io/steamcmd/steamcmd:latest "${args[@]}" 2>/dev/null || true)
  fi
  # "branches" { "public" { "buildid" "<n>" … } }
  build=$(printf '%s\n' "$out" | tr -d '\r' | awk '/"branches"/{b=1} b&&/"public"/{p=1} p&&/"buildid"/{gsub(/[^0-9]/,"",$2); print $2; exit}')
  [ -n "$build" ] && { echo "$build"; exit 0; }
  sleep 5
done
echo "no build id from Steam" >&2
exit 1
