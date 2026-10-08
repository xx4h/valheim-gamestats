# gamestats tools

## extract_gamedata.py — Valheim item icons, item and creature stats

The equipment paper doll and the item pages use the game's own inventory icons,
English names and stats. They are extracted from the dedicated server's files
once and copied onto the gamestats PVC (`/data/icons/valheim/`: one PNG per
item and style variant plus `items.json`, served by nginx under `/icons/`).
Not in git: they are Iron Gate's assets (and ~7 MB).

Re-run after a game update that adds or changes items. The bundle names come
from `valheim_server_Data/StreamingAssets/SoftRef/manifest_extended`; the
script prints which ones it wants. As of Valheim 1.0.16: prefabs in
`c4210710` (+ `11b3f7ee`), icons in `6a33a62`, `d59cfac`.

    SR=/home/container/valheim_server_Data/StreamingAssets/SoftRef
    mkdir -p work/Bundles && kubectl -n "$NS" exec "$POD" -c game -- cat $SR/manifest_extended > work/manifest_extended
    kubectl -n "$NS" exec "$POD" -c game -- cat /home/container/valheim_server_Data/resources.assets > work/resources.assets
    for b in c4210710 11b3f7ee 6a33a62 d59cfac; do kubectl -n "$NS" exec "$POD" -c game -- cat $SR/Bundles/$b > work/Bundles/$b; done

`kubectl exec` streams can break off on the 760 MB bundle — compare
`sha256sum` with the server's and resume with `tail -c +<size+1>` if needed.

UnityPy is not in nixpkgs; on NixOS its wheels also need libstdc++:

    nix shell nixpkgs#python312 -c python3 -m venv work/venv && work/venv/bin/pip install UnityPy
    LD_LIBRARY_PATH=$(nix build --no-link --print-out-paths nixpkgs#stdenv.cc.cc.lib)/lib work/venv/bin/python extract_gamedata.py work/manifest_extended work/Bundles work/resources.assets work/out

`resources.assets` holds the `localization*` CSVs (English names, descriptions).

## render_looks.py — the player figure on the gear page

Renders the player model (male and female body with the game's skin and underwear
textures) and every hairstyle and beard into transparent PNG layers in one frame,
into `<out>/looks/` with a `looks.json` index. The page stacks them per player and
tints them like the game's shader: skin layer × skin colour, hair and beard × hair
colour (the plugin reports them, `equipment` → `look`). Hair and beard meshes come
in assorted spaces; every mesh is placed through the player skeleton (bone world
matrix × bind pose), so they land on the head. Three old styles without a skeleton
binding (Hair1, Hair2, Beard1) are attached at the `Helmet_attach` joint instead,
the way the game's `VisEquipment.AttachItem` does. Same bundles and venv as above, plus numpy and
Pillow; takes about a minute. Run it into the same `work/out` **before** the upload
below — the upload replaces the whole folder, `looks/` included:

    LD_LIBRARY_PATH=$(nix build --no-link --print-out-paths nixpkgs#stdenv.cc.cc.lib)/lib:$(nix build --no-link --print-out-paths nixpkgs#zlib)/lib work/venv/bin/python render_looks.py work/manifest_extended work/Bundles work/out/items.json work/out

(`pip install UnityPy numpy pillow` in the venv.)

Upload (replaces the whole set, so renamed or removed items don't linger):

    tar cf - -C work/out . | kubectl -n gamestats exec -i deploy/gamestats -c collector -- sh -c 'rm -rf /data/icons/valheim.new && mkdir -p /data/icons/valheim.new && tar xf - -C /data/icons/valheim.new && rm -rf /data/icons/valheim && mv /data/icons/valheim.new /data/icons/valheim'

It also writes `creatures.json` (creature pages: health, faction, damage
modifiers, attacks — including what spells spawn, like Yagluth's meteors —
drops, trophy, specialties such as regeneration and stagger immunity) from the
creature prefabs under `Assets/Characters/`, and adds to `items.json` how each
item is made and what it is used for (recipes under `Assets/GameElements/Recipes/`,
build pieces, smelters, ovens and fermenters under `Assets/GameElements/Pieces/`).
All of it lives in the same prefab bundle as the items. Pieces from other
bundles (a handful) are not covered.

What the page reads from `items.json` / `creatures.json` is documented at the
top of the script and next to `GD()` / `CD()` in `site/app.js`. Quality-dependent stats are stored as
`[base, perLevel]`; the value at quality q is `base + (q-1) * perLevel`.
