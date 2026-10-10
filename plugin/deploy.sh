#!/usr/bin/env bash
# Put the plugin on a game server without breaking the running one: written next to plugins/ and renamed into place.
# Never write over the loaded DLL — Mono reads method bodies from that file as it first runs them, so everything not
# run yet fails ("[Gamestats] …: Method has zero rva"); on 2026-10-06 combat went unrecorded for hours that way. The
# rename swaps the directory entry, the running server keeps the file it has open; the new one loads at the next restart.
#   NS=<namespace> POD=<game pod> [CONTAINER=game] [ROOT=/home/container] ./deploy.sh [<path to dll> | <release version>]
# Without an argument: the local build. A version (e.g. 1.21.0): that release's DLL from GitHub (REPO=owner/name to use
# another repository's releases).
set -euo pipefail
: "${NS:?namespace of the game pod}" "${POD:?game pod}"
CONTAINER=${CONTAINER:-game} ROOT=${ROOT:-/home/container}
cd "$(dirname "$0")"
src=${1:-bin/Release/net48/ValheimGamestats.dll}
if [[ "$src" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  curl -fsSL -o "$tmp" "https://github.com/${REPO:-xx4h/valheim-gamestats}/releases/download/v$src/ValheimGamestats.dll"
  src=$tmp
fi
[ -s "$src" ] || { echo "no plugin at $src" >&2; exit 1; }
k() { kubectl -n "$NS" exec "$@"; }
P=$ROOT/BepInEx/plugins B=$ROOT/BepInEx
# the previous plugin, whatever its name (GamestatsEquipment.dll before 1.16.0), is kept as a backup
k "$POD" -c "$CONTAINER" -- sh -c "for f in '$P/ValheimGamestats.dll' '$P/GamestatsEquipment.dll'; do [ -f \"\$f\" ] && cp \"\$f\" '$B/gamestats-plugin.dll.bak' && break; done; true"
# in one step: the new file renamed into place, and the old name removed — two copies in plugins/ both load, and every
# event would count twice (removing a loaded DLL is as safe as the rename: the server keeps its open copy)
k -i "$POD" -c "$CONTAINER" -- sh -c "cat > '$B/ValheimGamestats.dll.next' && mv '$B/ValheimGamestats.dll.next' '$P/ValheimGamestats.dll' && rm -f '$P/GamestatsEquipment.dll'" < "$src"
want=$(sha256sum "$src" | cut -d' ' -f1)
have=$(k "$POD" -c "$CONTAINER" -- sha256sum "$P/ValheimGamestats.dll" | cut -d' ' -f1)
[ "$want" = "$have" ] || { echo "checksum mismatch: $have != $want" >&2; exit 1; }
left=$(k "$POD" -c "$CONTAINER" -- sh -c "ls '$P' | grep -i -e gamestats -e GamestatsEquipment" || true)
[ "$left" = "ValheimGamestats.dll" ] || { echo "plugins/ has more than the plugin: $left" >&2; exit 1; }
echo "staged ($want); the previous one is BepInEx/gamestats-plugin.dll.bak. Restart the server to load it:"
echo "BepInEx/LogOutput.log then says: Loading [Valheim Gamestats <version>]"
