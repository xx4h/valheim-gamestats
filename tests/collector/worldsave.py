"""Writes a Valheim world save (version 42, chunked) the way collector/valheim_world.py reads it — the
inverse of its parse_* functions, so it doubles as a description of the format.

    w = World().keys(["defeated_eikthyr"]).location("Eikthyrnir", 300, -200)
    w.piece("piece_chest_wood", 10, 20, creator=1001, items=[item("SwordIron", quality=3, crafter="Astrid", cid=1002)])
    w.tame("Wolf", 50, 60, name="Fenrir")
    files, names = w.files()
    snap = valheim_world.snapshot(files.__getitem__, files, w.save, names, {1001: "Ragnar"})

Little-endian throughout; strings are .NET BinaryWriter strings (7-bit length prefix, UTF-8).
Fields the parser skips are written as zeros: their meaning is not asserted here.
"""
import gzip
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "collector"))

from valheim_gamestats.valheim_world import TICKS, WORLD_VERSION, stable_hash  # noqa: E402


class Vec3(tuple):
    """A ZDO Vector3 value."""


class Quat(tuple):
    """A ZDO Quaternion value."""


# ZDO keys the game stores as longs (player ids, .NET ticks); other Python ints are written as ints.
LONGS = {"creator", "owner", "timeOfDeath", "spawntime", "StartTime"}


def s(v):
    b = v.encode()
    n, out = len(b), bytearray()
    while True:
        out.append((n & 0x7F) | (0x80 if n > 0x7F else 0))
        n >>= 7
        if not n:
            return bytes(out) + b


def count(n):
    """ZDO per-type item count: one byte, or two (big-endian, high bit set) from 128 on."""
    return bytes([n]) if n < 0x80 else bytes([0x80 | n >> 8, n & 0xFF])


def item(prefab, stack=1, quality=1, crafter="", cid=0, custom=None):
    return {"prefab": prefab, "stack": stack, "quality": quality, "crafter": crafter, "cid": cid, "custom": custom or {}}


def inventory(items, version=110):
    """Inventory blob (Inventory.Save): version, u16 count, per item a flag byte saying which fields follow."""
    out = struct.pack("<iH", version, len(items))
    for it in items:
        it = item(*it) if isinstance(it, tuple) else it
        fl = 0x40 | (0x04 if it["quality"] != 1 else 0) | (0x08 if it["stack"] != 1 else 0)
        fl |= (0x20 if it["crafter"] else 0) | (0x80 if it["custom"] else 0)
        out += struct.pack("<i", 0) + bytes(3) + bytes([fl])  # skipped by the parser
        if fl & 0x04:
            out += struct.pack("<H", it["quality"])
        if fl & 0x08:
            out += struct.pack("<H", it["stack"])
        # 0x10 (an int the parser skips) is never written
        if fl & 0x20:
            out += struct.pack("<q", it["cid"]) + s(it["crafter"])
        out += struct.pack("<i", stable_hash(it["prefab"]))
        if fl & 0x80:
            out += count(len(it["custom"])) + b"".join(s(k) + s(v) for k, v in it["custom"].items())
        if version >= 109 or version == 107:
            out += b"\0"  # trailing byte of 107 and 109+
    return out


def shared_map(explored, pins, version=3):
    """Cartography table "data" (Minimap.GetSharedMapData), gzip: square explored grid + pins (name, kind, x, z)."""
    out = struct.pack("<ii", version, len(explored)) + bytes(1 if e else 0 for e in explored)
    out += struct.pack("<i", len(pins))
    for name, kind, x, z in pins:
        out += struct.pack("<q", 0) + s(name) + struct.pack("<fffi", x, 0, z, kind) + b"\0" + s("Steam_76561190000000000")
    return gzip.compress(out)


def zdo(prefab, x, z, data, rot=None, connection=None, small=None):
    """One ZDO: u16 flags, position, prefab hash, optional rotation/connection, then the data grouped by type."""
    groups = {0x02: [], 0x04: [], 0x08: [], 0x10: [], 0x20: [], 0x40: [], 0x80: []}
    for k, v in data.items():
        h = struct.pack("<i", stable_hash(k))
        if isinstance(v, Vec3):
            groups[0x04].append(h + struct.pack("<fff", *v))
        elif isinstance(v, Quat):
            groups[0x08].append(h + struct.pack("<ffff", *v))
        elif isinstance(v, float):
            groups[0x02].append(h + struct.pack("<f", v))
        elif isinstance(v, int) and k in LONGS:
            groups[0x20].append(h + struct.pack("<q", v))
        elif isinstance(v, int):  # bools too: the game stores them as ints
            groups[0x10].append(h + struct.pack("<i", v))
        elif isinstance(v, str):
            groups[0x40].append(h + s(v))
        elif isinstance(v, (bytes, bytearray)):
            groups[0x80].append(h + struct.pack("<i", len(v)) + bytes(v))
        else:
            raise TypeError(f"{k}: {type(v)}")
    if small is None:
        small = all(isinstance(c, int) and -0x8000 <= c < 0x8000 for c in (x, z))
    fl = (0x2000 if small else 0) | (0x1000 if rot is not None else 0) | (0x01 if connection else 0)
    fl |= sum(bit for bit, g in groups.items() if g)
    out = struct.pack("<H", fl)
    out += struct.pack("<hh", x, z) if small else struct.pack("<fff", x, 0, z)
    out += struct.pack("<i", stable_hash(prefab))
    if rot is not None:  # small rotation: one u16 with 0x8000 set, or two u16
        out += struct.pack("<H", 0x8000 | rot) if rot < 0x8000 else struct.pack("<HH", rot & 0x7FFF, 0)
    if connection:
        out += bytes([connection[0]]) + struct.pack("<i", stable_hash(connection[1]))
    for g in groups.values():
        if g:
            out += count(len(g)) + b"".join(g)
    return out


class World:
    def __init__(self, version=WORLD_VERSION, chunk_version=None, net_time=10_000.0, save=7):
        self.version, self.chunk_version = version, chunk_version if chunk_version is not None else version
        self.net_time, self.save = net_time, save
        self.objs, self._keys, self.locs, self.zones = [], [], [], []
        self.extra_names = set()

    # --- world objects ------------------------------------------------------------------------
    def obj(self, prefab, x=0, z=0, data=None, rot=None, connection=None, small=None, **kw):
        """Any ZDO; data keys are the game's ZDO var names (kw for the ones that are identifiers)."""
        self.objs.append((prefab, x, z, {**(data or {}), **kw}, rot, connection, small))
        return self

    def piece(self, prefab, x=0, z=0, creator=1001, items=None, **kw):
        if items is not None:
            kw["items"] = inventory(items)
            self.extra_names |= {(it[0] if isinstance(it, tuple) else it["prefab"]) for it in items}
        return self.obj(prefab, x, z, creator=creator, **kw) if creator else self.obj(prefab, x, z, **kw)

    def tame(self, prefab, x=0, z=0, name=None, **kw):
        kw.setdefault("tamed", 1)
        if name:
            kw["TamedName"] = name
        return self.obj(prefab, x, z, **kw)

    def portal(self, tag, x=0, z=0, creator=1001, prefab="portal_wood"):
        return self.obj(prefab, x, z, creator=creator, tag=tag)

    def bed(self, owner_id, owner_name, x=0, z=0, creator=None, prefab="bed"):
        return self.obj(prefab, x, z, creator=creator or owner_id, owner=owner_id, ownerName=owner_name)

    def tombstone(self, owner_name, items, died, x=0, z=0, owner_id=None):
        """died: world clock seconds; stored as .NET ticks."""
        self.extra_names |= {(it[0] if isinstance(it, tuple) else it["prefab"]) for it in items}
        kw = {"owner": owner_id} if owner_id else {}
        return self.obj("Player_tombstone", x, z, ownerName=owner_name, items=inventory(items),
                        timeOfDeath=round(died * TICKS), **kw)

    def sign(self, text, x=0, z=0, creator=1001, author="Steam_76561190000000001"):
        return self.obj("sign", x, z, creator=creator, text=text, author=author)

    def table(self, explored, pins=(), x=0, z=0, creator=1001):
        return self.obj("piece_cartographytable", x, z, data={"data": shared_map(explored, pins)}, creator=creator)

    def stand(self, prefab, x=0, z=0, *items, creator=1001):
        """Item stand ("item") or armor stand ("<slot>_item"): what hangs on it, as a prefab hash."""
        self.extra_names |= set(items)
        if prefab.startswith("ArmorStand"):
            d = {f"{i}_item": stable_hash(it) for i, it in enumerate(items)}
        else:
            d = {"item": stable_hash(items[0])}
        return self.obj(prefab, x, z, data=d, creator=creator)

    # --- the db2 header -------------------------------------------------------------------------
    def keys(self, keys):
        self._keys += keys
        return self

    def location(self, name, x=0, z=0, placed=True):
        self.locs.append((name, x, z, placed))
        return self

    def generated(self, *zones):
        self.zones += zones
        return self

    def db2(self):
        """Header (version, net time) + compressed zone block: generated zones, global keys, locations."""
        z = struct.pack("<i", len(self.zones)) + b"".join(struct.pack("<hh", *zz) for zz in self.zones)
        z += struct.pack("<i", 0)  # location version (skipped)
        z += struct.pack("<i", len(self._keys)) + b"".join(s(k) for k in self._keys)
        z += b"\1"  # locations generated
        z += struct.pack("<i", len(self.locs))
        for name, x, zz, placed in self.locs:
            z += struct.pack("<ifff?", stable_hash(name), x, 0, zz, placed)
        z = zlib.compress(z)
        return struct.pack("<idi", self.version, self.net_time, len(z)) + z

    # --- files ------------------------------------------------------------------------------------
    def chunks(self):
        """{(region x, region z): [ZDO bytes]} — 512 m regions; only the file names depend on it."""
        out = {}
        for prefab, x, z, d, rot, conn, small in self.objs:
            out.setdefault((int(x) // 512 & 0xFF, int(z) // 512 & 0xFF), []).append(zdo(prefab, x, z, d, rot, conn, small))
        return out

    def files(self, total=None):
        """({file name: bytes}, {stable_hash: prefab name}). total overrides the object count in .chunks."""
        files, entries = {}, []
        for (cx, cz), zdos in sorted(self.chunks().items()):
            name = f"{cx:02x}_{cz:02x}__1_{self.save}.chunk"
            files[name] = struct.pack("<hi", self.chunk_version, len(zdos)) + b"".join(zdos)
            entries.append(struct.pack("<HBIi", cx << 8 | cz, 1, self.save, len(zdos)))
        total = len(self.objs) if total is None else total
        files[f"_main.{self.save}.chunks"] = struct.pack("<Hii", 1, total, len(entries)) + b"".join(entries)
        files[f"_main.{self.save}.db2"] = self.db2()
        files[f"_main.{self.save}.ok"] = b""
        names = {o[0] for o in self.objs} | {n for n, *_ in self.locs} | self.extra_names
        return files, {stable_hash(n): n for n in names}
