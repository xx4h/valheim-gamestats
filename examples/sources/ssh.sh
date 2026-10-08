#!/bin/sh
# A file source over SSH, for a Valheim server the collector can't mount or reach through Pelican:
#   world.script: "/path/to/ssh.sh valheim@game.example.com /home/valheim/valheim-server"
# The collector adds "list <dir>" or "get <path>" (collector/valheim_gamestats/sources.py, ScriptSource); relative paths
# are below the server directory given here. Needs ssh (with a key: BatchMode, no prompts) where the collector runs —
# the collector image has only Python, so this is for collectors outside a container or in an image that adds ssh —
# and a POSIX shell with stat on the server.
set -eu
host=$1 root=$2 op=$3 path=$4
case "$path" in /*) full=$path ;; *) full=$root/$path ;; esac
# the path, quoted for the remote shell
q=$(printf "'%s'" "$(printf '%s' "$full" | sed "s/'/'\\\\''/g")")
case "$op" in
  list)
    # name<TAB>mtime per file, as JSON: [{"name": …, "modified_at": <epoch seconds>}]
    ssh -o BatchMode=yes "$host" "cd $q && for f in * .*; do [ -f \"\$f\" ] && printf '%s\t%s\n' \"\$f\" \"\$(stat -c %Y \"\$f\")\"; done; true" | awk -F '\t' 'BEGIN { printf "[" } { gsub(/\\/, "\\\\", $1); gsub(/"/, "\\\"", $1); printf "%s{\"name\":\"%s\",\"modified_at\":%s}", (NR > 1 ? "," : ""), $1, $2 } END { print "]" }'
    ;;
  get)
    ssh -o BatchMode=yes "$host" "cat $q"
    ;;
  *)
    echo "usage: $0 <user@host> <server dir> list <dir> | get <path>" >&2
    exit 2
    ;;
esac
