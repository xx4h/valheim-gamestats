#!/usr/bin/env python3
"""Extract Valheim item icons and item stats from the dedicated server's files.

The page draws equipment and item pages with the game's own icons, names and
stats. The server build ships all of it: item prefabs live in one SoftRef
bundle, their icon sprites in another, English names in the `localization`
CSVs of resources.assets. For every item prefab this reads its ItemDrop
component (m_itemData.m_shared) and writes

  <out>/<Prefab>.png        icon, variant 0
  <out>/<Prefab>__<v>.png   further style variants (shields, capes, …)
  <out>/items.json          {prefab: stats} — see item() for the fields, plus "recipes" (how it is
                            made), "from" (smelted / cooked out of) and "uses" (see uses())
  <out>/creatures.json      {prefab: stats} — see creature() for the fields

Stats per quality q are base + (q-1) * perLevel, as the game computes them;
fields are stored as [base, perLevel] and the page does the arithmetic.
Which fields an item gets follows the game's own tooltip (armor only on
armor, block on shields and weapons, …), because every prefab carries
defaults for all of them.

Bundle names change with game updates; the script finds them in the SoftRef
manifest. Needs UnityPy (pip), not stdlib — run on a workstation (README.md).
"""
import csv
import io
import json
import os
import re
import sys
from collections import Counter

import UnityPy

# ItemDrop.ItemData.ItemType
CONSUMABLE, AMMO, AMMO_NE = 2, 9, 23
SHIELD = 5
ARMOR = {6, 7, 11, 17}                       # helmet, chest, legs, shoulder
WEAPON = {3, 4, 14, 15, 19, 20, 22}          # one-/two-handed, bow, torch, tool, atgeir, two-handed left
BLOCKS = WEAPON - {4} | {SHIELD}
EQUIP = ARMOR | WEAPON | {SHIELD, AMMO, 18, 24}  # + utility, trinket
DAMAGE = ("damage", "blunt", "slash", "pierce", "chop", "pickaxe", "fire", "frost", "lightning", "poison", "spirit")
SKILLS = {1: "Swords", 2: "Knives", 3: "Clubs", 4: "Polearms", 5: "Spears", 6: "Blocking", 7: "Axes", 8: "Bows",
          9: "Elemental magic", 10: "Blood magic", 11: "Unarmed", 12: "Pickaxes", 13: "Wood cutting", 14: "Crossbows",
          100: "Jump", 101: "Sneak", 102: "Run", 103: "Swim", 104: "Fishing", 105: "Cooking", 106: "Farming",
          107: "Crafting", 108: "Dodge", 110: "Ride", 999: "All skills"}
# HitData.DamageModifier
MODIFIER = {0: "Normal", 1: "Resistant", 2: "Weak", 3: "Immune", 4: "Ignore", 5: "Very resistant", 6: "Very weak",
            7: "Slightly resistant", 8: "Slightly weak"}
DAMAGE_BITS = {1: "Blunt", 2: "Slash", 4: "Pierce", 8: "Chop", 16: "Pickaxe", 32: "Fire", 64: "Frost",
               128: "Lightning", 256: "Poison", 512: "Spirit"}
# Character.Faction
FACTION = {1: "Animal", 2: "Forest monster", 3: "Undead", 4: "Demon", 5: "Mountain monster", 6: "Sea monster",
           7: "Plains monster", 8: "Boss", 9: "Mistlands monster", 10: "Dverger"}
# What a creature's damage modifiers mean for the page (Ignore = can't be hurt that way at all, e.g. chop on a bear)
MOD_GROUP = {1: ("resist", ""), 5: ("resist", " (very)"), 7: ("resist", " (slightly)"),
             2: ("weak", ""), 6: ("weak", " (very)"), 8: ("weak", " (slightly)"), 3: ("immune", "")}
COMBAT = ("blunt", "slash", "pierce", "fire", "frost", "lightning",
          "poison", "spirit")  # chop/pickaxe only hit trees, rocks, buildings

# Status-effect fields that are bookkeeping, not stats.
SE_SKIP = re.compile(r"^m_(Enabled|Name|name|tooltip|startMessage|stopMessage|repeatMessage|.*MessageType|.*Interval"
                     r"|activationAnimation|icon|ttl|cooldown|flashIcon|category|repeatInterval|attributes|startEffects"
                     r"|stopEffects|.*Effects?|GameObject|Script)$")


def localization(resources):
    loc = {}
    env = UnityPy.load(resources)
    for o in env.objects:
        if o.type.name != "TextAsset":
            continue
        t = o.read()
        if not t.m_Name.startswith("localization"):
            continue
        raw = t.m_Script if isinstance(t.m_Script, str) else t.m_Script.decode("utf-8", "replace")
        rows = csv.reader(io.StringIO(raw.lstrip("﻿")))
        try:
            col = next(rows).index("English")
        except (StopIteration, ValueError):
            continue
        for r in rows:
            if len(r) > col and r[0] and r[col]:
                loc.setdefault(r[0], r[col])
    return loc


def main(manifest, bundle_dir, resources, out):
    loc = localization(resources)
    # "$key", or several keys in one string ("$item_upgrader_tier3 $item_upgrader_weapon $item_upgrader_name")
    tr = lambda s: (loc.get(s[1:]) or re.sub(r"\$(\w+)", lambda m: loc.get(m.group(1), m.group(0)), s)) \
        if isinstance(s, str) and s.startswith("$") else s
    text = open(manifest, encoding="utf-8-sig", errors="replace").read().replace("\r", "")
    entries = re.findall(r"- asset ID: \S+\n  bundle: (\S+)\n  path in bundle: (.+)", text)
    prefab_bundles = {b for b, p in entries if p.startswith("Assets/GameElements/Items/") and p.endswith(".prefab")}
    icon_bundles = {b for b, p in entries if re.search(r"/_?icons/", p, re.I)}
    files = [os.path.join(bundle_dir, b) for b in sorted(prefab_bundles | icon_bundles)]
    present = [f for f in files if os.path.exists(f)]
    print(f"{len(loc)} localized strings; bundles {[os.path.basename(f) for f in present]}"
          f"{'; missing ' + str([os.path.basename(f) for f in files if f not in present]) if len(present) < len(files) else ''}")
    env = UnityPy.load(*present)
    by_id = {o.path_id: o for o in env.objects}  # 64-bit hashed ids, unique across these bundles

    def se_tree(ref):
        o = by_id.get((ref or {}).get("m_PathID") or 0)
        return o.read_typetree() if o is not None else None

    # pass 1: item trees, and every status effect they reference (for the field defaults)
    items, se_seen = [], []
    for path, obj in env.container.items():
        if not (path.lower().startswith("assets/gameelements/items/") and path.endswith(".prefab")):
            continue
        go = obj.read()
        for comp in go.m_Components:
            c = (comp.component if hasattr(comp, "component") else comp).deref()
            if c.type.name != "MonoBehaviour":
                continue
            try:
                tree = c.read_typetree()
            except Exception:
                continue
            if "m_itemData" in tree:
                sh = tree["m_itemData"]["m_shared"]
                items.append((go.m_Name, sh))
                for k in ("m_equipStatusEffect", "m_setStatusEffect", "m_fullAdrenalineSE"):
                    if (t := se_tree(sh.get(k))):
                        se_seen.append(t)
                break
    mode = {}
    for k in {k for t in se_seen for k in t}:
        vals = Counter(json.dumps(t.get(k), sort_keys=True) for t in se_seen)
        mode[k] = json.loads(vals.most_common(1)[0][0])

    def status_effect(ref):
        t = se_tree(ref)
        if not t:
            return None
        out = {"name": tr(t.get("m_name") or ""), "tooltip": tr(t.get("m_tooltip") or "")}
        stats = {}
        for k, v in t.items():
            if SE_SKIP.match(k) or v == mode.get(k):
                continue
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                stats[k[2:]] = round(v, 4)
        for key in ("skillLevel", "skillLevel2", "raiseSkill", "modifyAttackSkill"):
            if key in stats:
                stats[key] = SKILLS.get(int(stats[key]), stats[key])
        mods = [{"type": DAMAGE_BITS.get(m["m_type"], m["m_type"]), "mod": MODIFIER.get(m["m_modifier"], m["m_modifier"])}
                for m in t.get("m_mods") or []]
        if stats:
            out["stats"] = stats
        if mods:
            out["res"] = mods
        return out

    os.makedirs(out, exist_ok=True)
    db = {}
    for name, sh in items:
        icons = 0
        for v, ref in enumerate(sh.get("m_icons") or []):
            sp = by_id.get(ref["m_PathID"])
            if sp is None or sp.type.name != "Sprite":
                continue
            sp.read().image.save(os.path.join(out, f"{name}.png" if v == 0 else f"{name}__{v}.png"), optimize=True)
            icons += 1
        db[name] = item(sh, tr, status_effect, icons)
    uses(env, by_id, tr, db)
    with open(os.path.join(out, "items.json"), "w") as f:
        json.dump(db, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"{len(db)} items, {sum(1 for d in db.values() if d.get('icons'))} with icons, "
          f"items.json {os.path.getsize(os.path.join(out, 'items.json')) // 1024} KiB")

    cr = creatures(env, by_id, tr)
    spawns(env, by_id, tr, cr)
    with open(os.path.join(out, "creatures.json"), "w") as f:
        json.dump(cr, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"{len(cr)} creatures, creatures.json {os.path.getsize(os.path.join(out, 'creatures.json')) // 1024} KiB")


def owner(by_id, ref):
    """The GameObject a reference points to, directly or through one of its components."""
    o = by_id.get((ref or {}).get("m_PathID") or 0)
    if o is None:
        return None
    if o.type.name == "GameObject":
        return o.read()
    try:
        g = by_id.get(o.read_typetree()["m_GameObject"]["m_PathID"])
        return g.read() if g is not None else None
    except Exception:
        return None


def trees_of(go):
    out = []
    for comp in go.m_Components:
        c = (comp.component if hasattr(comp, "component") else comp).deref()
        if c.type.name == "MonoBehaviour":
            try:
                out.append(c.read_typetree())
            except Exception:
                pass
    return out


def damage_parts(dm):
    return [f"{dm[f'm_{k}']:g} {k}" for k in COMBAT if (dm or {}).get(f"m_{k}")]


def spawned_damage(by_id, ref, depth=0):
    """What an attack's projectile / spawn / area prefab deals: (damage parts, how many, area radius).
    Follows SpawnAbility (Yagluth's meteor rain spawns 10 meteor projectiles) and spawn-on-hit."""
    go = owner(by_id, ref) if depth < 4 else None
    if go is None:
        return None
    for t in trees_of(go):
        if "m_spawnPrefab" in t and "m_maxToSpawn" in t:  # SpawnAbility
            for sub in t["m_spawnPrefab"] or []:
                if (r_ := spawned_damage(by_id, sub, depth + 1)):
                    return r_[0], max(t.get("m_maxToSpawn") or 1, 1) * r_[1], r_[2]
        if isinstance(t.get("m_damage"), dict):  # Projectile (m_aoe) or Aoe (m_radius)
            if (parts := damage_parts(t["m_damage"])):
                return parts, 1, t.get("m_aoe") or t.get("m_radius") or 0
            if (r_ := spawned_damage(by_id, t.get("m_spawnOnHit"), depth + 1)):
                return r_
    return None


def uses(env, by_id, tr, db):
    """What every item is for, from the recipes (Assets/GameElements/Recipes) and the build pieces:
    db[item]["recipes"]: [{"n": amount made, "st": station, "lv": station level, "res": [[item, amount, per upgrade]]}]
    db[item]["from"]:    [{"i": item, "at": piece}]   smelted, cooked, fermented … out of
    db[item]["uses"]:    {"k": "craft", "i": item, "n", "up", "st"} ingredient (n to craft, up per upgrade)
                         {"k": "build", "p": piece, "n", "st"}      building material
                         {"k": "convert", "i": item, "at": piece}   turned into, at that piece
                         {"k": "fuel", "at": piece}"""
    def name(ref):
        go = owner(by_id, ref)
        return go.m_Name if go is not None else None

    stations = {}

    def station(ref):
        go = owner(by_id, ref)
        if go is None:
            return None
        if go.m_Name not in stations:
            t = next((t for t in trees_of(go) if "m_rangeBuild" in t), None)  # CraftingStation
            stations[go.m_Name] = tr(t["m_name"]) if t and t.get("m_name") else go.m_Name
        return stations[go.m_Name]

    seen = set()

    def use(item, u):
        key = (item, json.dumps(u, sort_keys=True))
        if item in db and key not in seen:
            seen.add(key)
            db[item].setdefault("uses", []).append(u)

    for path, obj in env.container.items():
        if not (path.startswith("Assets/GameElements/Recipes/") and path.endswith(".asset")):
            continue
        t = obj.read_typetree()
        made = name(t.get("m_item"))
        if not t.get("m_enabled") or made not in db:
            continue
        res = [[n, x.get("m_amount") or 0, x.get("m_amountPerLevel") or 0] for x in t.get("m_resources") or []
               if (n := name(x.get("m_resItem")))]
        st = station(t.get("m_craftingStation"))
        rec = {"n": t.get("m_amount") or 1, "res": res}
        if st:
            rec.update(st=st, lv=t.get("m_minStationLevel") or 1)
        db[made].setdefault("recipes", []).append(rec)
        for n, amount, per in res:
            use(n, {"k": "craft", "i": made, "n": amount, "up": per, "st": st})

    for path, obj in env.container.items():
        if not (path.startswith("Assets/GameElements/Pieces/") and path.endswith(".prefab")):
            continue
        try:
            go = obj.read()
        except Exception:
            continue
        trees = trees_of(go)
        piece = next((t for t in trees if "m_resources" in t and "m_category" in t), None)
        pname = tr(piece["m_name"]) if piece and piece.get("m_name") else go.m_Name
        if piece:
            st = station(piece.get("m_craftingStation"))
            for x in piece.get("m_resources") or []:
                if (n := name(x.get("m_resItem"))):
                    use(n, {"k": "build", "p": pname, "n": x.get("m_amount") or 0, "st": st})
        for t in trees:
            for c in t.get("m_conversion") or []:  # Smelter, CookingStation, Fermenter
                frm, to = name(c.get("m_from")), name(c.get("m_to"))
                if frm and to:
                    use(frm, {"k": "convert", "i": to, "at": pname})
                    if to in db and {"i": frm, "at": pname} not in db[to].setdefault("from", []):
                        db[to]["from"].append({"i": frm, "at": pname})
            if isinstance(t.get("m_fuelItem"), dict) and (n := name(t["m_fuelItem"])):
                use(n, {"k": "fuel", "at": pname})


# Heightmap.Biome bits, the boss keys a spawn waits for
BIOMES = [(1, "Meadows"), (8, "Black Forest"), (2, "Swamp"), (4, "Mountain"), (16, "Plains"), (512, "Mistlands"),
          (32, "Ashlands"), (64, "Deep North"), (256, "Ocean")]
BOSS_KEYS = {"defeated_eikthyr": "Eikthyr", "defeated_gdking": "The Elder", "defeated_bonemass": "Bonemass",
             "defeated_dragon": "Moder", "defeated_goblinking": "Yagluth", "defeated_queen": "The Queen",
             "defeated_fader": "Fader"}


def spawns(env, by_id, tr, cr):
    """Where and when each creature appears, added to creatures.json:
    "spawns": [{"biomes", "day", "night", "after"?, "weather"?, "group": [min, max], "stars", "where"?}] from the world's
              spawn lists (Assets/Systems/SpawnLists: what roams a biome), and
    "spawners": [{"src", "kind": "point" | "nest", "respawn"?: minutes}] from fixed spawners placed in camps, dungeons and
              the like (CreatureSpawner, "point": one creature) and nests (SpawnArea, "nest": spawns several kinds)."""
    def go_name(ref):
        o = by_id.get((ref or {}).get("m_PathID") or 0)
        if o is None:
            return None
        if o.type.name == "GameObject":
            return o.read().m_Name
        try:
            return by_id[o.read_typetree()["m_GameObject"]["m_PathID"]].read().m_Name
        except Exception:
            return None

    def trees(go):
        out = []
        for comp in go.m_Components:
            c = (comp.component if hasattr(comp, "component") else comp).deref()
            if c.type.name == "MonoBehaviour":
                try:
                    out.append(c.read_typetree())
                except Exception:
                    pass
        return out

    for path, obj in env.container.items():
        if path.startswith("Assets/Systems/SpawnLists/") and path.endswith(".prefab"):
            for t in trees(obj.read()):
                for e in t.get("m_spawners") or []:
                    who = go_name(e.get("m_prefab"))
                    if not e.get("m_enabled") or e.get("m_devDisabled") or who not in cr:
                        continue
                    biomes = [n for bit, n in BIOMES if (e.get("m_biome") or 0) & bit]
                    where = []
                    if e.get("m_inForest") and not e.get("m_outsideForest"):
                        where.append("in forests")
                    elif e.get("m_outsideForest") and not e.get("m_inForest"):
                        where.append("outside forests")
                    area = e.get("m_biomeArea")
                    if area == 1:
                        where.append("at biome edges")
                    elif area == 2:
                        where.append("deep inside the biome")
                    if (e.get("m_minOceanDepth") or 0) > 0:
                        where.append("in deep water")
                    if (e.get("m_minAltitude") or 0) > 0 and "Ocean" not in biomes:
                        where.append(f"above {e['m_minAltitude']:g} m")
                    key = e.get("m_requiredGlobalKey") or ""
                    sp = {"biomes": biomes, "day": bool(e.get("m_spawnAtDay")), "night": bool(e.get("m_spawnAtNight")),
                          "group": [e.get("m_groupSizeMin") or 1, e.get("m_groupSizeMax") or 1],
                          "stars": max((e.get("m_maxLevel") or 1) - 1, 0)}
                    if key:
                        sp["after"] = BOSS_KEYS.get(key, key)
                    if e.get("m_requiredEnvironments"):
                        sp["weather"] = list(e["m_requiredEnvironments"])
                    if where:
                        sp["where"] = where
                    if sp not in cr[who].setdefault("spawns", []):
                        cr[who]["spawns"].append(sp)
        elif path.endswith(".prefab") and "spawner" in path.lower():
            try:
                go = obj.read()
            except Exception:
                continue
            for t in trees(go):
                src = go.m_Name
                if "m_creaturePrefab" in t:  # CreatureSpawner
                    who = go_name(t["m_creaturePrefab"])
                    if who in cr:
                        e = {"src": src, "kind": "point"}
                        if t.get("m_respawnTimeMinuts"):
                            e["respawn"] = round(t["m_respawnTimeMinuts"])
                        if e not in cr[who].setdefault("spawners", []):
                            cr[who]["spawners"].append(e)
                elif "m_prefabs" in t and "m_levelupChance" in t:  # SpawnArea (nests)
                    label = next((tr(x["m_name"]) for x in trees(go)
                                  if isinstance(x.get("m_name"), str) and x["m_name"].startswith("$")), src)
                    for x in t["m_prefabs"] or []:
                        who = go_name(x.get("m_prefab"))
                        if who in cr and {"src": label, "kind": "nest"} not in cr[who].setdefault("spawners", []):
                            cr[who]["spawners"].append({"src": label, "kind": "nest"})
    print(f"spawn rules for {sum(1 for c in cr.values() if c.get('spawns'))} creatures, "
          f"fixed spawners for {sum(1 for c in cr.values() if c.get('spawners'))}")


def creatures(env, by_id, tr):
    """Creature prefabs (Assets/Characters/): the component with health and faction is the
    Character/Humanoid (script names don't resolve from this bundle, so fields identify it),
    m_drops the CharacterDrop, m_fedDuration the Tameable."""
    def name_of(ref):
        o = by_id.get((ref or {}).get("m_PathID") or 0)
        return o.read().m_Name if o is not None else None

    out = {}
    for path, obj in env.container.items():
        if not (path.lower().startswith("assets/characters/") and path.endswith(".prefab")):
            continue
        go = obj.read()
        trees = []
        for comp in go.m_Components:
            c = (comp.component if hasattr(comp, "component") else comp).deref()
            if c.type.name == "MonoBehaviour":
                try:
                    trees.append(c.read_typetree())
                except Exception:
                    pass
        ch = next((x for x in trees if "m_health" in x and "m_faction" in x), None)
        if ch is None or not ch.get("m_faction") or go.m_Name in out:  # faction 0: players
            continue
        out[go.m_Name] = creature(go.m_Name, ch, next((x for x in trees if "m_drops" in x), None),
                                  any("m_fedDuration" in x for x in trees), by_id, name_of, tr,
                                  next((x for x in trees if "m_afraidOfFire" in x), None))
        # rideable: the Tameable names the saddle item (Lox, Asksvin, Moose)
        saddle = next((x["m_saddleItem"] for x in trees if (x.get("m_saddleItem") or {}).get("m_PathID")), None)
        if saddle and (g := owner(by_id, saddle)) is not None:
            out[go.m_Name]["saddle"] = g.m_Name
    return out


def creature(prefab, ch, drop, tame, by_id, name_of, tr, ai=None):
    d = {"name": tr(ch.get("m_name") or prefab), "hp": r(ch.get("m_health") or 0)}
    if ch.get("m_boss"):
        d["boss"] = True
    if (f := FACTION.get(ch.get("m_faction"))):
        d["faction"] = f
    if tame:
        d["tame"] = True
    groups = {}
    for k in COMBAT:
        g = MOD_GROUP.get((ch.get("m_damageModifiers") or {}).get(f"m_{k}"))
        if g:
            groups.setdefault(g[0], []).append(k.capitalize() + g[1])
    d.update(groups)
    # specialties: only what differs from an ordinary creature (Character / BaseAI defaults)
    sp = {}
    if ai is not None and ch.get("m_regenAllHPTime"):
        sp["regen"] = r(ch["m_regenAllHPTime"])  # BaseAI heals max health / this, per second
    if ch.get("m_staggerDamageFactor") == 0:
        sp["noStagger"] = True
    if ch.get("m_staggerWhenBlocked") == 0:
        sp["noBlockStagger"] = True
    if (tol := [k for k in ("fire", "smoke", "tar") if ch.get(f"m_tolerate{k.capitalize()}")]):
        sp["tolerates"] = tol
    if ch.get("m_tolerateWater") == 0:
        sp["hurtByWater"] = True
    if ch.get("m_flying"):
        sp["flies"] = True
    if ai is not None and ai.get("m_afraidOfFire"):
        sp["afraidOfFire"] = True
    if ai is not None and (ai.get("m_fleeIfLowHealth") or 0) > 0:
        sp["fleesAt"] = r(ai["m_fleeIfLowHealth"])
    if sp:
        d["special"] = sp
    # attacks: the creature's default items (claws, bites, spit …), base damage per hit
    attacks, seen = [], set()
    for ref in ch.get("m_defaultItems") or []:
        o = by_id.get((ref or {}).get("m_PathID") or 0)
        if o is None:
            continue
        g = o.read()
        for comp in g.m_Components:
            c = (comp.component if hasattr(comp, "component") else comp).deref()
            if c.type.name != "MonoBehaviour":
                continue
            try:
                t = c.read_typetree()
            except Exception:
                continue
            if "m_itemData" not in t:
                continue
            sh = t["m_itemData"]["m_shared"]
            parts, note = damage_parts(sh.get("m_damages") or {}), None
            if not parts:  # spells: the damage is on what the attack spawns (meteors, beams, novas)
                for a in (sh.get("m_attack") or {}, sh.get("m_secondaryAttack") or {}):
                    for k in ("m_attackProjectile", "m_spawnOnTrigger"):
                        if not parts and (sp_ := spawned_damage(by_id, a.get(k))):
                            parts, n, radius = sp_
                            note = ", ".join(x for x in (f"×{n} per cast" if n > 1 else "",
                                                         f"{radius:g} m area" if radius else "") if x)
            if not parts:
                break
            label = re.sub(r"[_ ]?[lr]$", "", g.m_Name, flags=re.I)  # swipe_l / swipe_r are one attack
            label = re.sub(rf"^{re.escape(prefab)}_?", "", label, flags=re.I) or g.m_Name
            label = label.replace("_", " ").strip().capitalize()
            key = (label, " + ".join(parts))
            if key not in seen:
                seen.add(key)
                attacks.append({"name": label, "dmg": key[1], **({"note": note} if note else {})})
            break
    if attacks:
        d["attacks"] = attacks
    drops = []
    for x in (drop or {}).get("m_drops") or []:
        item = name_of(x.get("m_prefab"))
        if item:
            drops.append({"item": item, "min": x.get("m_amountMin", 1), "max": x.get("m_amountMax", 1),
                          "chance": r(x.get("m_chance", 1.0))})
            if item.startswith("Trophy"):
                d["trophy"] = item
    if drops:
        d["drops"] = drops
    return d


def r(v):
    return round(v, 3) if isinstance(v, float) else v


def item(sh, tr, status_effect, icons):
    t = sh.get("m_itemType")
    d = {"name": tr(sh.get("m_name") or ""), "type": t, "maxQ": sh.get("m_maxQuality") or 1,
         "weight": r(sh.get("m_weight") or 0), "icons": icons}
    if sh.get("m_variants"):
        d["variants"] = sh["m_variants"]
    if (desc := tr(sh.get("m_description") or "")) and not desc.startswith("$"):
        d["desc"] = desc
    if sh.get("m_value"):
        d["value"] = sh["m_value"]
    if sh.get("m_teleportable") == 0:
        d["noTeleport"] = True
    if sh.get("m_useDurability"):
        d["dur"] = [r(sh.get("m_maxDurability") or 0), r(sh.get("m_durabilityPerLevel") or 0)]
    if t in ARMOR:
        d["armor"] = [r(sh.get("m_armor") or 0), r(sh.get("m_armorPerLevel") or 0)]
    if t in BLOCKS and sh.get("m_blockPower"):
        d["block"] = [r(sh["m_blockPower"]), r(sh.get("m_blockPowerPerLevel") or 0)]
        d["deflect"] = [r(sh.get("m_deflectionForce") or 0), r(sh.get("m_deflectionForcePerLevel") or 0)]
        d["parry"] = r(sh.get("m_timedBlockBonus") or 0)
    if t in WEAPON | {AMMO, AMMO_NE}:
        base, lvl = sh.get("m_damages") or {}, sh.get("m_damagesPerLevel") or {}
        dmg = {k: [r(base.get(f"m_{k}", 0)), r(lvl.get(f"m_{k}", 0))] for k in DAMAGE if base.get(f"m_{k}") or lvl.get(f"m_{k}")}
        if dmg:
            d["dmg"] = dmg
        if t in WEAPON:
            atk = sh.get("m_attack") or {}
            for k, src in (("stamina", "m_attackStamina"), ("eitr", "m_attackEitr"), ("health", "m_attackHealth")):
                if atk.get(src):
                    d[k] = r(atk[src])
            d["backstab"] = r(sh.get("m_backstabBonus") or 0)
            d["knockback"] = r(sh.get("m_attackForce") or 0)
            if sh.get("m_skillType") in SKILLS:
                d["skill"] = SKILLS[sh["m_skillType"]]
    if t in EQUIP:
        mods = {k[2:]: r(sh[k]) for k in ("m_movementModifier", "m_eitrRegenModifier", "m_heatResistanceModifier",
                                          "m_homeItemsStaminaModifier", "m_jumpStaminaModifier", "m_attackStaminaModifier",
                                          "m_blockStaminaModifier", "m_dodgeStaminaModifier", "m_swimStaminaModifier",
                                          "m_sneakStaminaModifier", "m_runStaminaModifier") if sh.get(k)}
        if mods:
            d["mods"] = mods
        res = [{"type": DAMAGE_BITS.get(m["m_type"], m["m_type"]), "mod": MODIFIER.get(m["m_modifier"], m["m_modifier"])}
               for m in sh.get("m_damageModifiers") or [] if m.get("m_modifier")]
        if res:
            d["res"] = res
        if (se := status_effect(sh.get("m_equipStatusEffect"))):
            d["equipSE"] = se
        if sh.get("m_maxAdrenaline") and (se := status_effect(sh.get("m_fullAdrenalineSE"))):
            d["adrenaline"] = {"max": r(sh["m_maxAdrenaline"]), "se": se}  # trinkets: effect when the bar is full
        if sh.get("m_setName") and (se := status_effect(sh.get("m_setStatusEffect"))):
            d["set"] = {"name": sh["m_setName"], "size": sh.get("m_setSize") or 0, "se": se}
    if t == CONSUMABLE and (sh.get("m_food") or sh.get("m_foodStamina") or sh.get("m_foodEitr")):
        d["food"] = {k: r(sh.get(src) or 0) for k, src in (("health", "m_food"), ("stamina", "m_foodStamina"),
                                                             ("eitr", "m_foodEitr"), ("duration", "m_foodBurnTime"),
                                                             ("regen", "m_foodRegen"))}
    if t == CONSUMABLE and (se := status_effect(sh.get("m_consumeStatusEffect"))):
        d["consumeSE"] = se
    return d


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit("usage: extract_gamedata.py <SoftRef/manifest_extended> <SoftRef/Bundles dir> <resources.assets> <out dir>")
    main(*sys.argv[1:])
