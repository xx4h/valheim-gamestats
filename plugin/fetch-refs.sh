#!/usr/bin/env bash
# The reference assemblies the plugin builds against, into lib/. They are Iron Gate's, BepInEx's and ValheimRcon's:
# gitignored, never committed or redistributed — everyone fetches their own.
#
#   ./fetch-refs.sh          from their public sources, as CI does:
#                            the Valheim dedicated server through SteamCMD (anonymous login, Steam app 896660),
#                            BepInExPack Valheim and ValheimRcon from Thunderstore (the versions below)
#   ./fetch-refs.sh --pod    from a running server through kubectl, so the build matches exactly what it runs:
#                            NS=<namespace> POD=<game pod> [CONTAINER=game] [ROOT=/home/container] ./fetch-refs.sh --pod
#
# Public sources need curl and unzip, and steamcmd — or podman/docker for the steamcmd/steamcmd image. The server
# download (~1 GB) is kept in $STEAM_DIR (default ~/.cache/valheim-server) and only updated afterwards. The Steam build
# id of the game the plugin was built against ends up in lib/valheim-build.txt.
set -euo pipefail
BEPINEX=${BEPINEX:-5.4.2351}  # denikson/BepInExPack_Valheim
RCON=${RCON:-1.6.3}           # Tristan/ValheimRcon
# where the server download is kept: a relative STEAM_DIR is the caller's, so it's resolved before the cd below
STEAM_DIR=${STEAM_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/valheim-server}
mkdir -p "$STEAM_DIR"
STEAM_DIR=$(cd "$STEAM_DIR" && pwd)
cd "$(dirname "$0")"
mkdir -p lib
GAME=(valheim_server_Data/Managed/assembly_valheim.dll valheim_server_Data/Managed/assembly_utils.dll
  valheim_server_Data/Managed/UnityEngine.dll valheim_server_Data/Managed/UnityEngine.CoreModule.dll
  valheim_server_Data/Managed/PlayFab.dll)

if [ "${1:-}" = "--pod" ]; then
  : "${NS:?namespace of the game pod}" "${POD:?game pod}"
  CONTAINER=${CONTAINER:-game} ROOT=${ROOT:-/home/container}
  for f in "${GAME[@]}" BepInEx/core/BepInEx.dll BepInEx/core/0Harmony.dll BepInEx/plugins/ValheimRcon.dll; do
    kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- cat "$ROOT/$f" > "lib/$(basename "$f")"
  done
  echo "pod $NS/$POD" > lib/valheim-build.txt
  ls -l lib
  exit 0
fi

# the game: the dedicated server, anonymous (it's free)
args=(+force_install_dir /server +login anonymous +app_update 896660 +quit)
steam() {
  if command -v steamcmd >/dev/null; then steamcmd "${args[@]/\/server/$STEAM_DIR}"
  else
    run=$(command -v podman || command -v docker) || { echo "need steamcmd, podman or docker" >&2; exit 1; }
    "$run" run --rm -v "$STEAM_DIR:/server:z" docker.io/steamcmd/steamcmd:latest "${args[@]}"
  fi
}
# SteamCMD now and then fails an update for no reason of ours ("Missing configuration"): a fresh start fixes it
for try in 1 2 3; do
  steam && break
  [ "$try" = 3 ] && { echo "SteamCMD failed three times" >&2; exit 1; }
  echo "SteamCMD failed, again ($try)" >&2
  sleep 5
done
for f in "${GAME[@]}"; do cp "$STEAM_DIR/$f" lib/; done
build=$(sed -n 's/.*"buildid"[[:space:]]*"\([0-9]*\)".*/\1/p' "$STEAM_DIR/steamapps/appmanifest_896660.acf")
echo "steam build $build" > lib/valheim-build.txt

# the mod loader and the RCON server, from Thunderstore
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/bepinex.zip" "https://thunderstore.io/package/download/denikson/BepInExPack_Valheim/$BEPINEX/"
unzip -q -o -j "$tmp/bepinex.zip" "BepInExPack_Valheim/BepInEx/core/BepInEx.dll" "BepInExPack_Valheim/BepInEx/core/0Harmony.dll" -d lib
curl -fsSL -o "$tmp/rcon.zip" "https://thunderstore.io/package/download/Tristan/ValheimRcon/$RCON/"
unzip -q -o -j "$tmp/rcon.zip" "*ValheimRcon.dll" -d lib
ls -l lib
echo "built against: $(cat lib/valheim-build.txt), BepInExPack $BEPINEX, ValheimRcon $RCON"
