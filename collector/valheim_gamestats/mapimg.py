"""Map images for the gamestats page, written next to data.json (no image library needed).

- explored.png: the players' shared map (cartography tables) as a white-on-black mask, north up.
- terrain.png: biomes, water depth and hillshade, from the grid the server plugin samples with the
  game's own WorldGenerator once per world (plugin/Terrain.cs) — an 8-bit palette image.

The page lays the terrain under its zone squares and only shows it where players have been
(explored mask or a generated zone), so it spoils nothing they haven't seen.
"""
import gzip
import struct
import sys
import zlib
from array import array

TERRAIN_MAGIC = b"GSTR"

# Heightmap.Biome as stored by the plugin: index = log2(flag) + 1
BIOMES = {1: "meadows", 2: "swamp", 3: "mountain", 4: "blackforest", 5: "plains", 6: "ashlands", 7: "deepnorth",
          9: "ocean", 10: "mistlands"}
LAND = {  # base colour per biome, muted for a dark page
    "meadows": (143, 160, 90), "blackforest": (79, 107, 58), "swamp": (110, 90, 72), "mountain": (201, 204, 210),
    "plains": (200, 176, 106), "mistlands": (91, 86, 106), "ashlands": (122, 59, 48), "deepnorth": (223, 230, 239),
    "ocean": (150, 140, 110),  # ocean biome above water: sandbanks
}
SHADES = 12                      # hillshade steps per biome colour
WATER = 300                      # ZoneSystem.m_waterLevel (30 m), in the grid's decimetres
DEPTHS = 16                      # water depth steps
DEEP, SHALLOW = (24, 52, 72), (66, 110, 132)


def png(width, height, rows, color_type, palette=None):
    """rows: one bytes object per scanline (no filter byte). color_type 0 = grey, 3 = palette."""
    raw = b"".join(b"\0" + r for r in rows)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
    if palette:
        out += chunk(b"PLTE", b"".join(bytes(c) for c in palette))
    return out + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def explored_png(size, cells):
    """The shared map's explored flags (row 0 = south, as the game stores them) as a north-up mask."""
    rows = [bytes(255 if v else 0 for v in cells[r * size:(r + 1) * size]) for r in range(size - 1, -1, -1)]
    return png(size, size, rows, 0)


def parse_terrain(blob):
    """The plugin's grid: (size, extent m, seed, heights in dm, biome indices); row 0 = north, column 0 = west.
    Kept as a 16-bit array and bytes (~12 MB for 2048²): the collector runs in 256 MiB."""
    b = gzip.decompress(blob)
    if b[:4] != TERRAIN_MAGIC:
        raise ValueError("terrain: bad magic")
    ver, size, extent, seed = struct.unpack_from("<iifi", b, 4)
    if ver != 1:
        raise ValueError(f"terrain: version {ver}")
    n, off = size * size, 20
    if len(b) != off + 3 * n:
        raise ValueError("terrain: wrong length")
    heights = array("h")
    heights.frombytes(b[off:off + 2 * n])
    if sys.byteorder != "little":
        heights.byteswap()
    return size, extent, seed, heights, b[off + 2 * n:]


def terrain_png(size, extent, heights, biomes):
    names = list(LAND)
    palette = [tuple(round(min(255, c * (0.62 + 0.55 * s / (SHADES - 1)))) for c in LAND[n])
               for n in names for s in range(SHADES)]
    water0 = len(palette)
    palette += [tuple(round(SHALLOW[i] + (DEEP[i] - SHALLOW[i]) * d / (DEPTHS - 1)) for i in range(3)) for d in range(DEPTHS)]
    index = {i: names.index(n) for i, n in BIOMES.items()}
    step = 2 * extent / size
    rows = []
    for r in range(size):
        row = bytearray(size)
        o = r * size
        up, down = (o - size if r else o), (o + size if r < size - 1 else o)
        for c in range(size):
            h = heights[o + c]
            if h < WATER:
                row[c] = water0 + min(DEPTHS - 1, (WATER - h) // 40)  # 4 m per step
                continue
            # light from the north-west: slope towards it brightens
            dx = heights[o + c + 1 if c < size - 1 else o + c] - heights[o + c - 1 if c else o + c]
            dz = heights[up + c] - heights[down + c]
            light = 0.5 + (-dx + dz) / (40 * step) * 0.9  # heights in dm
            s = max(0, min(SHADES - 1, int(light * (SHADES - 1) + 0.5)))
            row[c] = index.get(biomes[o + c], 0) * SHADES + s
        rows.append(bytes(row))
    return png(size, size, rows, 3, palette)
