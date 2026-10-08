#!/usr/bin/env python3
"""Render the player figure for the gear page: body, underwear, every hairstyle and beard.

The game builds a Viking from the player model (male or female body, VisEquipment.m_models),
tinted by the skin colour, and a hair and a beard item (Items/customizations), tinted by the
hair colour (VisEquipment: _SkinColor on the materials). This renders the same meshes with the
game's own textures into transparent PNG layers that share one frame, so the page can stack and
tint them per player:

  <out>/looks/body<m>.png          the body, skin texture — tinted by the skin colour
  <out>/looks/body<m>_wear.png     underwear (and the bra on the female body), not tinted
  <out>/looks/<Hair|Beard…>_<m>.png  one hairstyle or beard on body <m>, grey — tinted by the hair colour
  <out>/looks/looks.json           {"frame": [x0, x1, z0, z1], "size": [w, h], "styles": {prefab: name}}

Every mesh is placed through the player skeleton like the game does: hair and beard meshes come
in assorted spaces and units (some in centimetres, some y-up), but in the rest pose bone world
matrix × the mesh's bind pose for that bone is the mesh's place in the world — one bone suffices,
no weights needed. The few old styles without a skeleton binding are attached at the head joint
instead (attached()). Front view (the character faces +z; its right hand ends up on the viewer's
left), smooth shading with a warm key light, supersampled. Hair and beard are rendered against
the body's depth, so what the head hides (long hair down the back) is left out.

Needs UnityPy, numpy and Pillow — run like extract_gamedata.py (README.md), same bundles.
"""
import json
import os
import re
import sys

import numpy as np
import UnityPy
from PIL import Image

SIZE = (400, 538)
SS = 3
FRAME = None  # screen x0, x1 (= -world x), world y0, y1 — fitted to the male body in main()
KEY = np.array([0.45, 0.55, 0.7]) / np.linalg.norm([0.45, 0.55, 0.7])      # world: from the viewer's left, above, in front
RIM = np.array([-0.6, 0.3, -0.4]) / np.linalg.norm([-0.6, 0.3, -0.4])
HAIR_GAIN = 1.6  # the hair texture is mid-grey; the shader's tint is applied on top of this


def objects(env):
    by_id = {o.path_id: o for o in env.objects}

    def deref(ref):
        return by_id.get((ref or {}).get("m_PathID") or 0)
    return by_id, deref


def walk(go):
    yield go
    for comp in go.m_Components:
        c = (comp.component if hasattr(comp, "component") else comp).deref()
        if c.type.name == "Transform":
            for ch in c.read().m_Children:
                yield from walk(ch.deref().read().m_GameObject.deref().read())


def trs(t):
    """4×4 local matrix of a Transform (Unity: T · R · S)."""
    px, py, pz = (t.m_LocalPosition.x, t.m_LocalPosition.y, t.m_LocalPosition.z)
    x, y, z, w = (t.m_LocalRotation.x, t.m_LocalRotation.y, t.m_LocalRotation.z, t.m_LocalRotation.w)
    sx, sy, sz = (t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z)
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * np.array([sx, sy, sz])
    M[:3, 3] = (px, py, pz)
    return M


def bone_worlds(root_go):
    """{bone name: world matrix} over a prefab's hierarchy."""
    out = {}

    def rec(tr, parent):
        t = tr.read()
        M = parent @ trs(t)
        out.setdefault(t.m_GameObject.deref().read().m_Name, M)
        for ch in t.m_Children:
            rec(ch.deref(), M)
    for comp in root_go.m_Components:
        c = (comp.component if hasattr(comp, "component") else comp).deref()
        if c.type.name == "Transform":
            rec(c, np.eye(4))
    return out


def placed(renderer, worlds):
    """(V, UV, N, F) of a SkinnedMeshRenderer in world space, via one of its bones (Head if it has one)."""
    mesh = renderer.m_Mesh.deref().read()
    V, T, N, F = mesh_arrays(mesh)
    names = [b.deref().read().m_GameObject.deref().read().m_Name for b in renderer.m_Bones]
    i = names.index("Head") if "Head" in names else next((k for k, n in enumerate(names) if n in worlds), None)
    if i is None or i >= len(mesh.m_BindPose):
        return None
    b = mesh.m_BindPose[i]
    BP = np.array([[getattr(b, f"e{r}{c}") for c in range(4)] for r in range(4)])
    M = worlds[names[i]] @ BP
    V = (np.c_[V, np.ones(len(V))] @ M.T)[:, :3]
    N = N @ np.linalg.inv(M[:3, :3])  # normals: inverse transpose
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
    return V, T, N, F


def attached(item_go, joint_world, deref):
    """Old-style items without a skeleton binding, placed like VisEquipment.AttachItem does: the item's "attach"
    child is copied and parented to the joint (Helmet_attach) with position and rotation zeroed and its own world
    scale kept; the renderers below it sit through their transform chain. [((V, UV, N, F), texture)]."""
    root = next((c.deref() for comp in item_go.m_Components for c in [comp.component if hasattr(comp, "component") else comp]
                 if c.deref().type.name == "Transform"), None)
    attach = next((ch.deref().read() for ch in root.read().m_Children
                   if ch.deref().read().m_GameObject.deref().read().m_Name in ("attach", "attach_skin")), None) if root else None
    if attach is None:
        return []
    R = joint_world[:3, :3] / np.linalg.norm(joint_world[:3, :3], axis=0)  # the joint's rotation, without its scale
    sc = attach.m_LocalScale
    base = np.eye(4)
    base[:3, :3] = R * np.array([sc.x, sc.y, sc.z])
    base[:3, 3] = joint_world[:3, 3]
    out = []

    def rec(tr, parent):
        t = tr.read()
        M = parent @ trs(t)
        g = t.m_GameObject.deref().read()
        comps = {c.deref().type.name: c.deref() for comp in g.m_Components
                 for c in [comp.component if hasattr(comp, "component") else comp]}
        renderer = comps.get("SkinnedMeshRenderer") or comps.get("MeshRenderer")
        mesh_ref = (renderer.read().m_Mesh if "SkinnedMeshRenderer" in comps else
                    (comps["MeshFilter"].read().m_Mesh if "MeshFilter" in comps else None))
        if renderer is not None and mesh_ref:
            V, T, N, F = mesh_arrays(mesh_ref.deref().read())
            V = (np.c_[V, np.ones(len(V))] @ M.T)[:, :3]
            N = N @ np.linalg.inv(M[:3, :3])
            N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
            if np.linalg.det(M[:3, :3]) < 0:  # a mirrored part (scale -1): flip the winding so it still faces out
                F = F[:, ::-1]
            out.append(((V, T, N, F), texture(deref, renderer.read_typetree()["m_Materials"][0], "_MainTex")))
        for ch in t.m_Children:
            rec(ch.deref(), M)
    for ch in attach.m_Children:
        rec(ch.deref(), base)
    return out


def mesh_arrays(mesh):
    """(V, UV, N, F) from a Unity mesh in its own space, via UnityPy's OBJ export (which negates x — undone here)."""
    V, T, N, F = [], [], [], []
    for line in mesh.export().splitlines():
        if line.startswith("v "):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("vt "):
            T.append([float(x) for x in line.split()[1:3]])
        elif line.startswith("vn "):
            N.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
            F.extend([idx[0], idx[k], idx[k + 1]] for k in range(1, len(idx) - 1))
    V, N = np.array(V), np.array(N)
    V[:, 0] *= -1
    N[:, 0] *= -1
    return V, np.array(T), N, np.array(F)


def texture(deref, mat, name):
    """RGBA float array of one texture slot of a material, or None."""
    o = deref(mat)
    if o is None:
        return None
    for slot, tex in o.read_typetree()["m_SavedProperties"]["m_TexEnvs"]:
        if slot == name and (t := deref(tex["m_Texture"])) is not None:
            return np.asarray(t.read().image.convert("RGBA")).astype(float) / 255
    return None


def sample(img, uv):
    H, W = img.shape[:2]
    x = np.clip(uv[..., 0] % 1 * W - 0.5, 0, W - 1.001)
    y = np.clip((1 - uv[..., 1] % 1) * H - 0.5, 0, H - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


class Canvas:
    """A supersampled colour + depth buffer in the shared frame."""

    def __init__(self):
        self.W, self.H = SIZE[0] * SS, SIZE[1] * SS
        self.rgba = np.zeros((self.H, self.W, 4))
        self.depth = np.full((self.H, self.W), -np.inf)

    def draw(self, mesh, img=None, gain=1.0, cut=None, write_color=True):
        """Rasterise; img None = depth only. cut: drop pixels whose texture alpha is below it."""
        V, T, N, F = mesh
        x0, x1, y0, y1 = FRAME
        P = np.stack([(-V[:, 0] - x0) / (x1 - x0) * self.W, (y1 - V[:, 1]) / (y1 - y0) * self.H, V[:, 2]], 1)
        for f in F:
            p = P[f]
            mnx, mxx = int(max(0, p[:, 0].min())), int(min(self.W - 1, p[:, 0].max()) + 1)
            mny, mxy = int(max(0, p[:, 1].min())), int(min(self.H - 1, p[:, 1].max()) + 1)
            if mnx >= mxx or mny >= mxy:
                continue
            xs, ys = np.meshgrid(np.arange(mnx, mxx) + 0.5, np.arange(mny, mxy) + 0.5)
            (ax, ay, az), (bx, by, bz), (cx, cy, cz) = p
            den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(den) < 1e-9:
                continue
            l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
            l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
            l3 = 1 - l1 - l2
            z = l1 * az + l2 * bz + l3 * cz
            sub = self.depth[mny:mxy, mnx:mxx]
            m = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6) & (z > sub)
            if not m.any():
                continue
            L = np.stack([l1[m], l2[m], l3[m]], 1)
            if img is None:
                sub[m] = z[m]
                continue
            col = sample(img, L @ T[f])
            if cut is not None:
                keep = col[:, 3] >= cut
                if not keep.any():
                    continue
                m[m] = keep
                L, col = L[keep], col[keep]
            n = L @ N[f]
            n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
            light = 0.42 + 0.62 * np.abs(n @ KEY) + 0.12 * np.clip(n @ RIM, 0, 1)
            sub[m] = z[m]
            if write_color:
                rgb = np.clip(col[:, :3] * gain * light[:, None], 0, 1)
                self.rgba[mny:mxy, mnx:mxx][m] = np.concatenate([rgb, np.ones((len(rgb), 1))], 1)

    def save(self, path):
        im = Image.fromarray((self.rgba * 255).astype(np.uint8), "RGBA").resize(SIZE, Image.LANCZOS)
        im.save(path, optimize=True)


def main(manifest, bundle_dir, items_json, out):
    text = open(manifest, encoding="utf-8-sig", errors="replace").read().replace("\r", "")
    entries = re.findall(r"- asset ID: \S+\n  bundle: (\S+)\n  path in bundle: (.+)", text)
    bundles = {b for b, p in entries if p.endswith("Characters/Player/Player.prefab") or "/customizations/" in p}
    env = UnityPy.load(*[os.path.join(bundle_dir, b) for b in sorted(bundles)])
    by_id, deref = objects(env)
    names = {k: v.get("name") for k, v in json.load(open(items_json)).items()}
    os.makedirs(os.path.join(out, "looks"), exist_ok=True)

    global FRAME
    bodies, raw = [], {}
    player = next(obj.read() for path, obj in env.container.items() if path.endswith("Characters/Player/Player.prefab"))
    worlds = bone_worlds(player)
    body_r = next((c.deref().read() for g in walk(player) for comp in g.m_Components
                   for c in [comp.component if hasattr(comp, "component") else comp]
                   if c.deref().type.name == "SkinnedMeshRenderer"
                   and c.deref().read().m_GameObject.deref().read().m_Name == "body"), None)
    for path, obj in env.container.items():
        if path.endswith("Characters/Player/Player.prefab"):
            for g in walk(obj.read()):
                for comp in g.m_Components:
                    c = (comp.component if hasattr(comp, "component") else comp).deref()
                    if c.type.name != "MonoBehaviour":
                        continue
                    try:
                        t = c.read_typetree()
                    except Exception:
                        continue
                    if "m_models" in t:
                        for mdl in t["m_models"]:  # male, female: their mesh on the body renderer's bones
                            mat = mdl["m_baseMaterial"]
                            mesh = deref(mdl["m_mesh"]).read()
                            bodies.append((mesh, texture(deref, mat, "_MainTex"),
                                           [x for x in (texture(deref, mat, "_LegsTex"), texture(deref, mat, "_ChestTex"))
                                            if x is not None]))
        elif m := re.search(r"/customizations/(?:hairs|beards)/(\w+)\.prefab$", path):
            item = obj.read()
            for g in walk(item):
                for comp in g.m_Components:
                    c = (comp.component if hasattr(comp, "component") else comp).deref()
                    if c.type.name == "SkinnedMeshRenderer":
                        r = c.read()
                        if r.m_Mesh and (pm := placed(r, worlds)) is not None:
                            raw.setdefault(m.group(1), []).append(
                                (pm, texture(deref, c.read_typetree()["m_Materials"][0], "_MainTex")))
            if m.group(1) not in raw and (parts := attached(item, worlds["Helmet_attach"], deref)):
                raw[m.group(1)] = parts  # Hair1, Hair2, Beard1: no skeleton binding, attached at the head joint
    styles = raw
    # the bodies: each model's mesh, placed through the body renderer's bones
    bone_names = [b.deref().read().m_GameObject.deref().read().m_Name for b in body_r.m_Bones]
    hb = bone_names.index("Head")
    placed_bodies = []
    for mesh, skin, wear in bodies:
        b = mesh.m_BindPose[hb]
        BP = np.array([[getattr(b, f"e{r}{c}") for c in range(4)] for r in range(4)])
        M = worlds["Head"] @ BP
        V, T, N, F = mesh_arrays(mesh)
        V = (np.c_[V, np.ones(len(V))] @ M.T)[:, :3]
        N = N @ np.linalg.inv(M[:3, :3])
        N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
        placed_bodies.append(((V, T, N, F), skin, wear))
    bodies = placed_bodies
    V0 = bodies[0][0][0]
    w = max(-V0[:, 0].min(), V0[:, 0].max()) * 1.04
    h0, h1 = V0[:, 1].min(), V0[:, 1].max()
    h = h1 - h0
    # same aspect as SIZE, the figure centred
    span_y = h * 1.03
    span_x = max(2 * w, span_y * SIZE[0] / SIZE[1])
    span_y = span_x * SIZE[1] / SIZE[0]
    FRAME = (-span_x / 2, span_x / 2, h0 - (span_y - h) / 2, h1 + (span_y - h) / 2)
    print(f"{len(bodies)} bodies, {len(styles)} hair/beard styles with a mesh, frame {[round(x, 3) for x in FRAME]}")

    for i, (mesh, skin, wear) in enumerate(bodies):
        cv = Canvas()
        cv.draw(mesh, skin)
        cv.save(os.path.join(out, "looks", f"body{i}.png"))
        # underwear: the same surface again, only where a wear texture covers it (its alpha)
        cw = Canvas()
        cw.depth[:] = cv.depth - 1e-9
        for tex in wear:
            if tex.shape[0] > 32:  # player_armor_none is a 32 px placeholder
                cw.draw(mesh, tex, cut=0.5)
        cw.save(os.path.join(out, "looks", f"body{i}_wear.png"))
        for name, parts in styles.items():
            cs = Canvas()
            cs.draw(mesh, None)  # the head hides what is behind it
            for smesh, stex in parts:
                grey = stex.copy() if stex is not None else np.ones((2, 2, 4))
                grey[..., :3] = grey[..., :3].mean(axis=2, keepdims=True)  # tinted by the hair colour on the page
                cs.draw(smesh, grey, gain=HAIR_GAIN)
            cs.save(os.path.join(out, "looks", f"{name}_{i}.png"))
    with open(os.path.join(out, "looks", "looks.json"), "w") as f:
        json.dump({"frame": FRAME, "size": SIZE, "bodies": len(bodies),
                   "styles": {k: names.get(k) or k for k in sorted(styles)}}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"looks/: {2 * len(bodies) + len(bodies) * len(styles)} layers")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit("usage: render_looks.py <SoftRef/manifest_extended> <SoftRef/Bundles dir> <items.json> <out dir>")
    main(*sys.argv[1:])
