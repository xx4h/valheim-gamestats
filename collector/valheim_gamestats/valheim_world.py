"""Valheim world-save reader for the gamestats collector.

Reads the chunked world save (world version 41, "Deep North" save system)
that a dedicated server keeps in worlds_local/<world>/:

  _main.<n>.ok       marker: save <n> is complete
  _main.<n>.db2      header + compressed zone data (global keys, locations)
  _main.<n>.chunks   which chunk files (and versions) make up save <n>
  XX_YY__S_V.chunk   world objects (ZDOs) of one region

Files are read through the server's file source (sources.py: Pelican, a
local directory or a script) and only aggregates are kept — sign authors and the player list in
the .fwl2 (Steam IDs) never leave this module. Positions are published
for the map only, and snapped to the 64 m zone for anything players made
or own (portals, bases, chests, tombstones, their shared map pins); the
world's own landmarks (boss altars, traders) and tamed creatures ("pets",
where they are is what the pets page is for) keep their exact position.

Format notes come from the game's own assembly (ZDO.Load, ZDOMan.LoadChunks,
ChunkSaveMapping.Load, ZoneSystem.Load, Inventory.Load). parse_* raise on
anything unexpected rather than guess, so a game update fails loudly.
"""
import gzip
import re
import struct
import zlib
from collections import Counter, defaultdict
from datetime import datetime

WORLD_VERSION = 41
SCHEMA = 12  # bump when snapshot() output changes; forces a re-read of the current save
ITEM_VERSIONS = (107, 108, 109)  # AbandonedDN, Smaller, ChunksNCheats

# Landmarks shown on the map once their zone is generated: location prefab -> (kind, label)
MAP_LOCATIONS = {
    "StartTemple": ("start", "Sacrificial stones"),
    "Eikthyrnir": ("altar", "Eikthyr"), "GDKing": ("altar", "The Elder"), "Bonemass": ("altar", "Bonemass"),
    "Dragonqueen": ("altar", "Moder"), "GoblinKing": ("altar", "Yagluth"),
    "Mistlands_DvergrBossEntrance1": ("altar", "The Queen"), "FaderLocation": ("altar", "Fader"),
    "Vendor_BlackForest": ("trader", "Haldor"), "Hildir_camp": ("trader", "Hildir"), "BogWitch_Camp": ("trader", "Bog Witch"),
    # dungeons: a way into an interior (site/app.js DUNGEON); every variant the game has a location for
    **{f"Crypt{i}": ("dungeon", "Burial chambers") for i in (1, 2, 3, 4)},
    **{f"SunkenCrypt{i}": ("dungeon", "Sunken crypt") for i in (1, 2, 3, 4)},
    **{f"TrollCave{i:02}": ("dungeon", "Troll cave") for i in (1, 2)},
    **{f"MountainCave{i:02}": ("dungeon", "Frost cave") for i in (1, 2)},
    **{f"Mistlands_DvergrTownEntrance{i}": ("dungeon", "Infested mine") for i in (1, 2)},
    "Hildir_crypt": ("dungeon", "Smouldering tomb"), "Hildir_cave": ("dungeon", "Howling cavern"),
    "Hildir_plainsfortress": ("dungeon", "Sealed tower"),
    **{f"MorgenHole{i}": ("dungeon", "Morgen hole") for i in (1, 2, 3)},
}
ZONE = 64  # ZoneSystem.c_ZoneSize
MAP_PX = 12  # metres per pixel of the game's map (Minimap.m_pixelSize on the prefab)
PLAYER_PINS = {0: "fire", 1: "house", 2: "hammer", 3: "point", 5: "bed", 6: "rune"}  # Minimap.PinType a player places
BASE_MIN_PIECES = 50  # a cluster of zones with fewer player-built pieces is not a base


def zone_of(x, z):
    return int((x + ZONE / 2) // ZONE), int((z + ZONE / 2) // ZONE)


BOSSES = [
    ("defeated_eikthyr", "Eikthyr"), ("defeated_gdking", "The Elder"), ("defeated_bonemass", "Bonemass"),
    ("defeated_dragon", "Moder"), ("defeated_goblinking", "Yagluth"), ("defeated_queen", "The Queen"),
    ("defeated_fader", "Fader"),
]


def stable_hash(s):
    """Valheim's string.GetStableHashCode()."""
    n1 = n2 = 5381
    i = 0
    while i < len(s) and s[i] != "\0":
        n1 = (((n1 << 5) + n1) ^ ord(s[i])) & 0xFFFFFFFF
        if i == len(s) - 1 or s[i + 1] == "\0":
            break
        n2 = (((n2 << 5) + n2) ^ ord(s[i + 1])) & 0xFFFFFFFF
        i += 2
    r = (n1 + n2 * 1566083941) & 0xFFFFFFFF
    return r - (1 << 32) if r >= 1 << 31 else r


K = {k: stable_hash(k) for k in (
    "creator", "items", "owner", "ownerName", "tamed", "TamedName", "text", "tag", "item", "data",
    "fuel", "queued", "SpawnAmount", "Content", "StartTime", "level",
    "spawntime", "TamedNameAuthor", "follow", "HaveSaddle", "health", "max_health", "timeOfDeath",
)}
SLOT_KEYS = {stable_hash(f"{i}_item") for i in range(16)}
COOK_SLOTS = [(stable_hash(f"slot{i}"), stable_hash(f"slotstatus{i}")) for i in range(8)]

# Production pieces whose state the stations card shows. Smelter-type pieces
# keep a "queued" count (+ "fuel" where they burn something); key names are
# from the game's Smelter/Fermenter/Beehive/SapCollector/CookingStation.
SMELTERS = ("smelter", "blastfurnace", "eitrrefinery", "charcoal_kiln", "windmill", "piece_spinningwheel", "piece_FrostKiln")
FUELED = ("smelter", "blastfurnace", "eitrrefinery", "piece_oven")
COLLECTORS = ("piece_beehive", "piece_sapcollector")
COOKERS = ("piece_cookingstation", "piece_cookingstation_iron", "piece_oven")
FERMENT_S = 2400  # Fermenter.m_fermentationDuration
TICKS = 10_000_000  # StartTime is in .NET ticks of the world clock


class Reader:
    def __init__(self, b):
        self.b, self.p = b, 0

    def take(self, n):
        if self.p + n > len(self.b):
            raise ValueError("unexpected end of data")
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def u8(self): return self.take(1)[0]
    def i16(self): return struct.unpack("<h", self.take(2))[0]
    def u16(self): return struct.unpack("<H", self.take(2))[0]
    def i32(self): return struct.unpack("<i", self.take(4))[0]
    def u32(self): return struct.unpack("<I", self.take(4))[0]
    def i64(self): return struct.unpack("<q", self.take(8))[0]
    def f32(self): return struct.unpack("<f", self.take(4))[0]
    def f64(self): return struct.unpack("<d", self.take(8))[0]
    def bool(self): return self.u8() != 0

    def str(self):  # .NET BinaryWriter: 7-bit encoded length prefix
        n = shift = 0
        while True:
            b = self.u8()
            n |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        return self.take(n).decode("utf-8", "replace")

    def num_items(self):
        n = self.u8()
        return ((n & 0x7F) << 8) | self.u8() if n & 0x80 else n

    def done(self):
        return self.p == len(self.b)


def _decompress(b):
    for f in (gzip.decompress, zlib.decompress, lambda x: zlib.decompress(x, -15)):
        try:
            return f(b)
        except Exception:
            pass
    raise ValueError("db2: unknown compression")


def parse_db2(b):
    r = Reader(b)
    ver = r.i32()
    if ver != WORLD_VERSION:
        raise ValueError(f"db2: world version {ver}, parser knows {WORLD_VERSION}")
    net_time = r.f64()
    z = Reader(_decompress(r.take(r.i32())))
    zones = z.i32()
    z.take(4 * zones)
    z.i32()  # location version
    keys = [z.str() for _ in range(z.i32())]
    z.bool()
    locs, marks = Counter(), []
    for _ in range(z.i32()):
        h = z.i32()
        x, _, zz = struct.unpack("<fff", z.take(12))
        if z.bool():  # placed: its zone has been generated
            locs[h] += 1
            if h in MAP_LOCATION_HASHES:
                marks.append((h, x, zz))
    return {"net_time": net_time, "zones": zones, "keys": keys, "locations": locs, "marks": marks}


MAP_LOCATION_HASHES = {stable_hash(n): n for n in MAP_LOCATIONS}


def parse_shared_map(b):
    """A cartography table's map (Minimap.GetSharedMapData, gzip): (size, explored bytes, pins)."""
    r = Reader(gzip.decompress(b))
    ver = r.i32()
    if ver != 3:
        raise ValueError(f"shared map version {ver}")
    n = r.i32()
    size = int(round(n ** 0.5))
    if size * size != n:
        raise ValueError(f"shared map: {n} cells is not a square")
    explored = r.take(n)
    pins = []
    for _ in range(r.i32()):
        r.i64()
        name = r.str()
        x, _, z = struct.unpack("<fff", r.take(12))
        kind = r.i32()
        r.bool()
        r.str()  # author: a platform id
        pins.append((name, kind, x, z))
    return size, explored, pins


def parse_chunk_map(b):
    r = Reader(b)
    r.u16()
    total = r.i32()
    files = []
    for _ in range(r.i32()):
        chunk, size, version, _n = r.u16(), r.u8(), r.u32(), r.i32()
        files.append(f"{chunk >> 8:02x}_{chunk & 0xFF:02x}__{size}_{version}.chunk")
    if not r.done():
        raise ValueError("chunks: trailing data")
    return total, files


def iter_zdos(b):
    """Yield (prefab_hash, data{key_hash: value}, (x, z)) for every ZDO in a chunk file."""
    r = Reader(b)
    ver = r.i16()
    if ver != WORLD_VERSION:
        raise ValueError(f"chunk: world version {ver}, parser knows {WORLD_VERSION}")
    for _ in range(r.i32()):
        fl = r.u16()
        if fl & 0x2000:  # small position: two shorts, y = 0
            x, z = struct.unpack("<hh", r.take(4))
        else:
            x, _, z = struct.unpack("<fff", r.take(12))
        prefab = r.i32()
        if fl & 0x1000:  # small rotation: 2 or 4 bytes
            if not r.u16() & 0x8000:
                r.u16()
        data = {}
        if fl & 0xFF:
            if fl & 0x01:
                r.u8()
                r.i32()
            for bit, read in ((0x02, r.f32), (0x04, lambda: r.take(12)), (0x08, lambda: r.take(16)), (0x10, r.i32),
                              (0x20, r.i64), (0x40, r.str), (0x80, lambda: r.take(r.i32()))):
                if fl & bit:
                    for _ in range(r.num_items()):
                        k = r.i32()
                        data[k] = read()
        yield prefab, data, (x, z)
    if not r.done():
        raise ValueError("chunk: trailing data")


def parse_items(b):
    """Container inventory blob -> [(prefab_hash, stack, quality, crafter_id, crafter_name)]."""
    r = Reader(b)
    ver = r.i32()
    if ver not in ITEM_VERSIONS:
        raise ValueError(f"inventory version {ver}")
    out = []
    for _ in range(r.u16()):
        r.i32()
        r.take(3)
        fl = r.u8()
        quality = r.u16() if fl & 0x04 else 1
        stack = r.u16() if fl & 0x08 else 1
        if fl & 0x10:
            r.i32()
        cid, cname = (r.i64(), r.str()) if fl & 0x20 else (0, "")
        prefab = r.i32() if fl & 0x40 else 0
        for _ in range(r.num_items() if fl & 0x80 else 0):
            r.str()
            r.str()
        if ver >= 109 or ver == 107:
            r.u8()
        out.append((prefab, stack, quality, cid, cname))
    return out


# --------------------------------------------------------------------------

def latest_save(files):
    nums = [int(m.group(1)) for n in files if (m := re.fullmatch(r"_main\.(\d+)\.ok", n))]
    nums = [n for n in nums if f"_main.{n}.db2" in files and f"_main.{n}.chunks" in files]
    return max(nums) if nums else None


PATH_RE = re.compile(rb"(Assets/[^\s]*?)([^/\s]+)\.prefab\b")


def _category(path):
    """Category from where the game keeps the asset — generic, so new items need no code."""
    if m := re.match(r"Assets/GameElements/Items/([^/_][^/]*)/", path):
        return m.group(1).lower()
    if path.startswith("Assets/GameElements/Pieces/"):
        return "pieces"
    if path.startswith("Assets/Characters/"):
        return "creatures"
    return ""


def prefab_index(manifest_bytes):
    """{prefab name: category} from the SoftRef asset manifest."""
    out = {}
    for m in PATH_RE.finditer(manifest_bytes):
        name, path = m.group(2).decode(), m.group(1).decode()
        cat = _category(path)
        if name not in out or (cat and not out[name]):
            out[name] = cat
    return out


def snapshot(fetch, files, save, names, players, cats=None):
    """Aggregate one save. fetch(name) -> bytes. players: {id: name}, updated in place.
    cats: {prefab name: category} for the per-item index."""
    cats = cats or {}
    nm = lambda h: names.get(h)
    db2 = parse_db2(fetch(f"_main.{save}.db2"))
    total, chunk_files = parse_chunk_map(fetch(f"_main.{save}.chunks"))

    # Per prefab; player-built things are keyed by creator id and resolved to
    # names at the end (an id's name may only be learned later in the pass).
    built = defaultdict(Counter)      # piece -> {creator_id: n}
    stored = Counter()                # item -> units in player-built chests (whoever filled them, not the builder's)
    crafted = defaultdict(Counter)    # item -> {crafter name: units}
    quality = defaultdict(Counter)    # (item, crafter name) -> {quality: units}
    shown = defaultdict(Counter)      # item -> {stand creator_id: n}
    chests = Counter()                # creator_id -> containers
    chest_items = Counter()           # creator_id -> units in their containers: how full they are, not whose
    tames, named, pets = Counter(), [], []
    portals = Counter()
    beds, tombs, signs = Counter(), Counter(), []
    stations = defaultdict(Counter)   # piece -> {n, busy, ready, queue, out, nofuel, burnt}
    kitchen = defaultdict(Counter)    # creator_id -> {done, burnt} food left on their cooking stations
    # for the map, per 64 m zone
    zone_pieces = defaultdict(Counter)  # zone -> {creator_id: pieces}
    zone_chests = Counter()             # zone -> player-built containers
    zone_stored = defaultdict(Counter)  # item -> {zone: units}
    zone_shown = defaultdict(Counter)   # item -> {zone: on item & armor stands}
    zone_tombed = defaultdict(Counter)  # item -> {zone: in tombstones}
    zone_portals, zone_tombs = [], []
    explored, shared_pins, map_size = None, {}, 0
    objects = 0
    for cf in chunk_files:
        for prefab, d, pos in iter_zdos(fetch(cf)):
            objects += 1
            if not d:
                continue
            name = nm(prefab) or ""
            owner, owner_name = d.get(K["owner"]), d.get(K["ownerName"])
            if isinstance(owner, int) and isinstance(owner_name, str) and owner and owner_name:
                players[owner] = owner_name
            creator = d.get(K["creator"]) if isinstance(d.get(K["creator"]), int) else 0
            zone = zone_of(*pos)
            if creator:
                built[prefab][creator] += 1
                if "sapling" not in name.lower():
                    zone_pieces[zone][creator] += 1
            # Only player-built containers: dungeon/treasure chests have no creator.
            if isinstance(d.get(K["items"]), (bytes, bytearray)) and creator:
                chests[creator] += 1
                zone_chests[zone] += 1
                for ip, stack, q, cid, cname in parse_items(d[K["items"]]):
                    stored[ip] += stack
                    chest_items[creator] += stack
                    zone_stored[ip][zone] += stack
                    if cname:
                        crafted[ip][cname] += stack
                        quality[(ip, cname)][q] += stack
                        if cid:
                            players.setdefault(cid, cname)
            if name in ("itemstand", "itemstandh") and isinstance(d.get(K["item"]), int) and d[K["item"]]:
                shown[d[K["item"]]][creator] += 1
                zone_shown[d[K["item"]]][zone] += 1
            if name.startswith("ArmorStand"):
                for k, v in d.items():
                    if k in SLOT_KEYS and isinstance(v, int) and v:
                        shown[v][creator] += 1
                        zone_shown[v][zone] += 1
            if (d.get(K["tamed"]) or d.get(K["TamedName"])) and not name.endswith(("_Summoned", "_Friendly")):
                tames[prefab] += 1
                if isinstance(d.get(K["TamedName"]), str) and d[K["TamedName"]]:
                    named.append([d[K["TamedName"]], prefab])
                pets.append(_pet(name or f"#{prefab}", d, pos))
            if name.startswith("portal"):
                portals[d.get(K["tag"], "") if isinstance(d.get(K["tag"]), str) else ""] += 1
                zone_portals.append((d.get(K["tag"]) if isinstance(d.get(K["tag"]), str) else "", zone))
            if name.startswith(("bed", "piece_bed")) and isinstance(owner_name, str) and owner_name:
                beds[owner_name] += 1
            if name == "Player_tombstone" and isinstance(owner_name, str):
                tombs[owner_name] += 1
                inv = Counter()  # (item, quality) -> units: the dead player's whole inventory
                if isinstance(d.get(K["items"]), (bytes, bytearray)):
                    for ip, stack, q, _, _ in parse_items(d[K["items"]]):
                        inv[(ip, q)] += stack
                        zone_tombed[ip][zone] += stack
                died = d.get(K["timeOfDeath"]) if isinstance(d.get(K["timeOfDeath"]), int) else 0
                zone_tombs.append((owner_name, zone, round(died / TICKS) if died else None, inv))
            if name == "piece_cartographytable" and isinstance(d.get(K["data"]), (bytes, bytearray)):
                size, ex, pins = parse_shared_map(d[K["data"]])
                if explored is None or size != map_size:
                    explored, map_size = bytearray(ex), size
                else:
                    for i, v in enumerate(ex):
                        if v:
                            explored[i] = 1
                for pn, kind, px, pz in pins:
                    if kind in PLAYER_PINS:
                        zx, zz = zone_of(px, pz)
                        shared_pins[(pn.strip(), kind, zx, zz)] = 1
            if name in SMELTERS or name in COLLECTORS or name in COOKERS or name == "fermenter":
                _station(stations[name], name, d, db2["net_time"])
            if name in COOKERS and creator:
                done, burnt = _cooked(d)
                kitchen[creator]["done"] += done
                kitchen[creator]["burnt"] += burnt
            if name.startswith("sign") and isinstance(d.get(K["text"]), str) and d[K["text"]].strip():
                signs.append(d[K["text"]].strip()[:200])  # text only — the author field is a platform ID
    if objects != total:
        raise ValueError(f"expected {total} objects, read {objects}")

    label = lambda h: nm(h) or f"#{h}"
    who = lambda cid: players.get(cid, "Unknown")

    def by_player(counter):
        out = Counter()
        for cid, n in counter.items():
            out[who(cid)] += n
        return dict(out.most_common())

    # One entry per prefab that players built, stored, crafted or displayed.
    items = {}
    def entry(h):
        return items.setdefault(label(h), {"c": cats.get(label(h), "")})
    for h, c in built.items():
        entry(h)["built"] = by_player(c)
    for h, n in stored.items():
        entry(h)["kept"] = n
    for h, c in crafted.items():
        e = entry(h)
        e["crafted"] = dict(c.most_common())
        e["q"] = {cn: {str(q): n for q, n in sorted(quality[(h, cn)].items())} for cn in c}
    for h, c in shown.items():
        entry(h)["shown"] = by_player(c)
    for h, c in zone_stored.items():  # where it is kept: every zone, most first — finding a lost item needs the last one too
        entry(h)["at"] = [[zx * ZONE, zz * ZONE, n] for (zx, zz), n in c.most_common()]
    for h, c in zone_shown.items():
        entry(h)["on"] = [[zx * ZONE, zz * ZONE, n] for (zx, zz), n in c.most_common()]
    for h, c in zone_tombed.items():
        entry(h)["tomb"] = [[zx * ZONE, zz * ZONE, n] for (zx, zz), n in c.most_common()]

    # Compact per-player views kept for the history and older page code.
    # Planted crops and tree saplings carry a creator too, but grow into objects without one:
    # counting them would read as building a field and tearing it down again.
    pieces_by = defaultdict(Counter)
    for h, c in built.items():
        if "sapling" in label(h).lower():
            continue
        for cid, n in c.items():
            pieces_by[who(cid)][label(h)] += n
    crafters = defaultdict(Counter)
    for h, c in crafted.items():
        for cn, n in c.items():
            crafters[cn][label(h)] += n
    storage = Counter({label(h): n for h, n in stored.items()})
    displayed = Counter({label(h): sum(c.values()) for h, c in shown.items()})
    keys = sorted(db2["keys"])
    snap = {
        "schema": SCHEMA,
        "net_time": round(db2["net_time"], 1),  # world clock (s) at save time: anchors the in-game day/night
        "save": save,
        "objects": objects,
        "zones": db2["zones"],  # zones generated per the save (health: vs the zone events)
        "keys": keys,
        "bosses": [[k, n, k in keys] for k, n in BOSSES],
        "pieces": {p: {"total": sum(c.values()), "top": c.most_common(12)} for p, c in pieces_by.items()},
        "storage": storage.most_common(150),
        "containers": sum(chests.values()),
        "chests": by_player(chests),
        "chest_items": by_player(chest_items),
        "crafted": {c: v.most_common(30) for c, v in crafters.items()},
        "displayed": displayed.most_common(),
        "items": items,
        "tames": [[label(h), n] for h, n in tames.most_common()],
        "named_tames": [[n, label(h)] for n, h in sorted(named)],
        "pets": pets,
        "portals": sorted([[t, n] for t, n in portals.items()], key=lambda x: (-x[1], x[0])),
        "beds": dict(beds),
        "tombstones": dict(tombs),
        "signs": sorted(signs),
        "stations": {n: {k: v for k, v in c.items() if v} for n, c in sorted(stations.items())},
        "kitchen": {who(cid): {k: v for k, v in c.items() if v} for cid, c in kitchen.items() if any(c.values())},
        "boss_altars": {label(h): n for h, n in db2["locations"].items()
                        if (nm(h) or "") in ("Eikthyrnir", "GDKing", "Bonemass", "Dragonqueen", "GoblinKing",
                                             "Mistlands_DvergrBossEntrance1", "FaderLocation")},
        "map": {
            "locations": [[*MAP_LOCATIONS[MAP_LOCATION_HASHES[h]], round(x), round(z), MAP_LOCATION_HASHES[h]]
                          for h, x, z in db2["marks"]],
            "portals": [[t, zx * ZONE, zz * ZONE] for t, (zx, zz) in sorted(zone_portals)],
            # [owner, x, z, died (world clock s), [[item, units, quality], …]]
            "tombs": [[o, zx * ZONE, zz * ZONE, died, [[label(h), n, q] for (h, q), n in inv.most_common()]]
                      for o, (zx, zz), died, inv in sorted(zone_tombs, key=lambda t: (t[0], t[2] or 0))],
            "pins": [[n, PLAYER_PINS[k], zx * ZONE, zz * ZONE] for (n, k, zx, zz) in sorted(shared_pins)],
            "bases": _bases(zone_pieces, zone_chests, zone_stored, who),
        },
    }
    if explored is not None:  # binary, written next to data.json by the collector, not part of the json
        snap["_explored"] = {"size": map_size, "px": MAP_PX, "cells": bytes(explored)}
    return snap


def _bases(zone_pieces, zone_chests, zone_stored, who):
    """Bases: neighbouring zones (8-way) with player-built pieces, at the zone with the most."""
    items = Counter()
    for c in zone_stored.values():
        for z, n in c.items():
            items[z] += n
    todo, out = set(zone_pieces), []
    while todo:
        stack, group = [todo.pop()], []
        while stack:
            z = stack.pop()
            group.append(z)
            for dx in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    n = (z[0] + dx, z[1] + dz)
                    if n in todo:
                        todo.remove(n)
                        stack.append(n)
        by = Counter()
        for z in group:
            for cid, n in zone_pieces[z].items():
                by[who(cid)] += n
        pieces = sum(by.values())
        if pieces < BASE_MIN_PIECES:
            continue
        cx, cz = max(group, key=lambda z: sum(zone_pieces[z].values()))
        out.append({"x": cx * ZONE, "z": cz * ZONE, "zones": len(group), "pieces": pieces,
                    "chests": sum(zone_chests[z] for z in group), "items": sum(items[z] for z in group),
                    "builders": by.most_common(3)})
    return sorted(out, key=lambda b: -b["pieces"])


def _pet(prefab, d, pos):
    """One tamed creature. "k" (prefab + BaseAI's spawntime, set once when it first spawned) is
    its identity across saves and restarts — ZDO ids are handed out anew on every load."""
    val = lambda k, t: d.get(K[k]) if isinstance(d.get(K[k]), t) else None
    spawn = val("spawntime", int) or 0
    out = {"k": f"{prefab}:{spawn}", "s": prefab, "x": round(pos[0]), "z": round(pos[1]),
           "lv": max((val("level", int) or 1) - 1, 0), "born": round(spawn / TICKS) if spawn else None}
    for key, field, t in (("n", "TamedName", str), ("by", "TamedNameAuthor", str), ("f", "follow", str)):
        if (v := val(field, t)):
            out[key] = v
    if (hp := val("health", float)) is not None:
        out["hp"] = round(hp)
    if (mx := val("max_health", float)):
        out["max"] = round(mx)
    if val("HaveSaddle", int):
        out["saddle"] = True
    return out


def _station(c, name, d, now):
    """Tally one production piece into its counter (zero keys are dropped later)."""
    num = lambda k: d.get(K[k]) if isinstance(d.get(K[k]), (int, float)) else 0
    c["n"] += 1
    if name in SMELTERS:
        q = num("queued")
        c["queue"] += q
        c["out"] += num("SpawnAmount")
        if q:
            c["busy"] += 1
            if name in FUELED and num("fuel") < 1:
                c["nofuel"] += 1
    elif name in COLLECTORS:
        lvl = num("level")
        c["out"] += lvl
        c["ready"] += lvl > 0
    elif name == "fermenter":
        if isinstance(d.get(K["Content"]), str) and d[K["Content"]]:
            done = now - num("StartTime") / TICKS >= FERMENT_S
            c["ready" if done else "busy"] += 1
    if name in COOKERS:
        slots = [(d.get(a), d.get(b)) for a, b in COOK_SLOTS]
        if any(isinstance(it, str) and it for it, _ in slots):
            c["busy"] += 1
        done, burnt = _cooked(d)
        c["ready"] += done
        c["burnt"] += burnt
        if name in FUELED and any(isinstance(it, str) and it for it, _ in slots) and num("fuel") < 1:
            c["nofuel"] += 1


def _cooked(d):
    """(done, burnt) slots of a cooking station: food nobody picked up."""
    slots = [(d.get(a), d.get(b)) for a, b in COOK_SLOTS]
    return (sum(1 for it, st in slots if it and st == 1),   # CookingStation.Status.Done
            sum(1 for it, st in slots if it and st == 2))   # Status.Burnt


def mtime(files, name):
    m = files.get(name, {}).get("modified_at")
    return round(datetime.fromisoformat(m.replace("Z", "+00:00")).timestamp()) if m else None
