#!/usr/bin/env bash
# The README's showcase, showcase.webp: the demo served, toured in Chromium on a desktop and a phone (demo/showcase.js,
# ~11 s) and both videos side by side as one animated WebP (~2 MB). CI does this for GitHub Pages
# (.github/workflows/pages.yml), where the README embeds it from — nothing of it is committed.
#   demo/showcase.sh OUT [SITE]   OUT/showcase.webp; SITE: a demo already built (demo/generate.py), else one is built
# Needs python3, ffmpeg, img2webp (libwebp) and the site tests' Playwright with Chromium (cd tests/site && npm ci) — the
# Playwright image has all but ffmpeg and webp (apt-get install ffmpeg webp).
set -euo pipefail
out=$(mkdir -p "${1:?output directory}" && cd "$1" && pwd)
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'kill "${server:-}" 2>/dev/null; rm -rf "$tmp"' EXIT
site=${2:-}
if [ -z "$site" ]; then site=$tmp/site; python3 demo/generate.py "$site"; fi
python3 -m http.server 8899 --bind 127.0.0.1 --directory "$site" >/dev/null 2>&1 &
server=$!
sleep 1
NODE_PATH=tests/site/node_modules node demo/showcase.js http://127.0.0.1:8899/ "$tmp/video"
# one picture: desktop and phone side by side at the same height (~960 px wide, the README's width), a transparent gap
# between them, as long as the shorter of the two recordings; the first second (the page loading) skipped
H=440
d=$(ls "$tmp/video/desktop"/*.webm) p=$(ls "$tmp/video/phone"/*.webm)
fc="[0:v]fps=12,scale=-2:$H:flags=lanczos,format=rgba,pad=iw+20:ih:0:0:color=black@0[a];[1:v]fps=12,scale=-2:$H:flags=lanczos,format=rgba[b];[a][b]hstack=inputs=2:shortest=1"
mkdir -p "$tmp/frames"
ffmpeg -loglevel error -y -ss 1.2 -i "$d" -ss 1.2 -i "$p" -filter_complex "$fc" "$tmp/frames/f-%04d.png"
# -mixed: lossless where it pays (flat UI), lossy elsewhere; plain lossy leaves tinted patches on the pale background
img2webp -loop 0 -mixed -m 6 -q 75 -d 83 "$tmp/frames"/f-*.png -o "$out/showcase.webp" >/dev/null
ls -l "$out/showcase.webp"
