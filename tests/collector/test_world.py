"""World save -> world.json (valheim_world.snapshot), one test per thing it reports; saves built by worldsave.World."""
import json
import struct
import unittest

from worldsave import (  # first: puts collector/ (the package's directory) on the path
    Quat,
    Vec3,
    World,
    inventory,
    item,
    shared_map,
    zdo,
)

from valheim_gamestats import valheim_world as vw

PLAYERS = {1001: "Ragnar", 1002: "Astrid"}


def snap(w, players=None, **kw):
    files, names = w.files(**kw)
    players = dict(PLAYERS) if players is None else players
    return vw.snapshot(files.__getitem__, files, w.save, names, players, {"SwordIron": "weapons"})


class Format(unittest.TestCase):
    def test_every_zdo_field_type_decodes(self):
        d = {"f": 1.5, "v": Vec3((1, 2, 3)), "q": Quat((0, 0, 0, 1)), "i": 7, "creator": 2**40, "s": "hé", "b": b"\1\2"}
        b = (struct.pack("<hi", 41, 2) + zdo("x", 1000.5, -2000.25, d, rot=0x1234, connection=(1, "y")) +
             zdo("y", 3, -4, {}, rot=0x9000))
        (p1, d1, pos1), (p2, d2, pos2) = vw.iter_zdos(b)
        self.assertEqual((p1, pos1, p2, d2, pos2), (vw.stable_hash("x"), (1000.5, -2000.25), vw.stable_hash("y"), {}, (3, -4)))
        self.assertEqual({k: (tuple(struct.unpack(f"<{len(v) // 4}f", v)) if k in ("v", "q") else v) for k, v in
                          ((k, d1[vw.stable_hash(k)]) for k in d)},
                         {**d, "v": (1, 2, 3), "q": (0, 0, 0, 1)})

    def test_more_than_127_values_of_a_type(self):
        b = struct.pack("<hi", 41, 1) + zdo("x", 0, 0, {f"k{i}": i for i in range(200)})
        (_, d, _), = vw.iter_zdos(b)
        self.assertEqual(d[vw.stable_hash("k199")], 199)

    def test_inventory_optional_fields(self):
        b = inventory([("Wood", 20), item("SwordIron", quality=3, crafter="Astrid", cid=1002, custom={"a": "b"}), ("Coins",)])
        self.assertEqual(vw.parse_items(b), [(vw.stable_hash("Wood"), 20, 1, 0, ""),
                                             (vw.stable_hash("SwordIron"), 1, 3, 1002, "Astrid"),
                                             (vw.stable_hash("Coins"), 1, 1, 0, "")])

    def test_inventory_versions_share_one_layout(self):
        for v in vw.ITEM_VERSIONS:
            self.assertEqual(vw.parse_items(inventory([("Wood", 20), ("Coins",)], version=v)),
                             [(vw.stable_hash("Wood"), 20, 1, 0, ""), (vw.stable_hash("Coins"), 1, 1, 0, "")], v)

    def test_save_mixing_world_versions(self):
        """After a game update the db2 and the chunks written since are 42, chunks untouched since stay 41."""
        w = World().piece("wood_wall", 10, 10, creator=1001).piece("wood_wall", -600, 1100, creator=1001)
        files, names = w.files()
        old = min(n for n in files if n.endswith(".chunk"))
        files[old] = struct.pack("<h", 41) + files[old][2:]
        s = vw.snapshot(files.__getitem__, files, w.save, names, dict(PLAYERS), {})
        self.assertEqual(s["pieces"]["Ragnar"]["total"], 2)

    def test_chunk_map_names_the_chunk_files(self):
        w = World().piece("wood_wall", 10, 10).piece("wood_wall", -600, 1100)
        files, _ = w.files()
        total, names = vw.parse_chunk_map(files["_main.7.chunks"])
        self.assertEqual((total, sorted(names)), (2, sorted(n for n in files if n.endswith(".chunk"))))

    def test_latest_save_needs_ok_db2_and_chunks(self):
        files = {f: {} for f in ("_main.7.ok", "_main.7.db2", "_main.7.chunks", "_main.8.ok", "_main.8.db2", "_main.9.db2")}
        self.assertEqual(vw.latest_save(files), 7)


class Fails(unittest.TestCase):
    def test_object_count_mismatch_raises(self):
        with self.assertRaisesRegex(ValueError, "expected 3 objects, read 2"):
            snap(World().piece("wood_wall").piece("wood_wall"), total=3)

    def test_wrong_world_version_raises(self):
        with self.assertRaisesRegex(ValueError, "db2: world version 40"):
            snap(World(version=40).piece("wood_wall"))
        with self.assertRaisesRegex(ValueError, "db2: world version 43"):
            snap(World(version=43).piece("wood_wall"))
        with self.assertRaisesRegex(ValueError, "chunk: world version 43"):
            snap(World(chunk_version=43).piece("wood_wall"))

    def test_unknown_inventory_version_raises(self):
        with self.assertRaisesRegex(ValueError, "inventory version 111"):
            vw.parse_items(inventory([("Wood", 1)], version=111))

    def test_unknown_shared_map_version_raises(self):
        with self.assertRaisesRegex(ValueError, "shared map version 4"):
            snap(World().obj("piece_cartographytable", data={"data": shared_map([0] * 4, [], version=4)}))

    def test_trailing_chunk_data_raises(self):
        with self.assertRaisesRegex(ValueError, "trailing"):
            list(vw.iter_zdos(struct.pack("<hi", 41, 0) + b"\0"))


class Snapshot(unittest.TestCase):
    def test_pieces_credited_to_the_creator(self):
        w = World().piece("wood_wall", creator=1001).piece("wood_wall", creator=1001).piece("stone_floor", creator=1002)
        w.piece("sapling_birch", creator=1001).obj("Pickable_Stone", picked=0)  # no creator: the world's, not a piece
        s = snap(w)
        self.assertEqual(s["pieces"], {"Ragnar": {"total": 2, "top": [("wood_wall", 2)]},
                                       "Astrid": {"total": 1, "top": [("stone_floor", 1)]}})
        self.assertEqual(s["items"]["wood_wall"]["built"], {"Ragnar": 2})
        self.assertEqual(s["objects"], 5)

    def test_unknown_creator_is_unknown(self):
        self.assertEqual(list(snap(World().piece("wood_wall", creator=4242))["pieces"]), ["Unknown"])

    def test_chest_counted_for_builder_contents_not_credited(self):
        w = World().piece("piece_chest_wood", 10, 20, creator=1001, items=[("Wood", 20), ("Stone", 5)])
        w.piece("TreasureChest_meadows", 30, 30, creator=0, items=[("Coins", 50)])  # dungeon chest: no creator
        s = snap(w)
        self.assertEqual((s["containers"], s["chests"], s["chest_items"]), (1, {"Ragnar": 1}, {"Ragnar": 25}))
        self.assertEqual(s["storage"], [("Wood", 20), ("Stone", 5)])
        self.assertEqual(s["crafted"], {})
        self.assertEqual(s["items"]["Wood"], {"c": "", "kept": 20, "at": [[0, 0, 20]]})
        self.assertNotIn("Coins", s["items"])

    def test_crafted_item_credited_to_crafter_with_quality(self):
        swords = [item("SwordIron", quality=3, crafter="Astrid", cid=1002),
                  item("SwordIron", quality=1, crafter="Astrid", cid=1002),
                  item("SwordIron", quality=3, crafter="Leif", cid=1003)]
        players = dict(PLAYERS)
        s = snap(World().piece("piece_chest_wood", creator=1001, items=swords), players)
        self.assertEqual(s["crafted"], {"Astrid": [("SwordIron", 2)], "Leif": [("SwordIron", 1)]})
        e = s["items"]["SwordIron"]
        self.assertEqual((e["c"], e["crafted"], e["q"]),
                         ("weapons", {"Astrid": 2, "Leif": 1}, {"Astrid": {"1": 1, "3": 1}, "Leif": {"3": 1}}))
        self.assertEqual(players[1003], "Leif")  # learned from the item
        self.assertEqual(s["chest_items"], {"Ragnar": 3})

    def test_item_and_armor_stands(self):
        w = World().stand("itemstand", 100, 0, "SwordIron", creator=1001).stand("itemstandh", 100, 0, "TrophyDeer", creator=1002)
        w.stand("ArmorStand_Male", 0, 0, "HelmetBronze", "ArmorBronzeChest", creator=1002)
        w.obj("itemstand", 5, 5, creator=1001, item=0)  # empty stand
        s = snap(w)
        self.assertEqual(sorted(s["displayed"]),
                         [("ArmorBronzeChest", 1), ("HelmetBronze", 1), ("SwordIron", 1), ("TrophyDeer", 1)])
        self.assertEqual((s["items"]["SwordIron"]["shown"], s["items"]["SwordIron"]["on"]), ({"Ragnar": 1}, [[128, 0, 1]]))
        self.assertEqual(s["items"]["HelmetBronze"]["shown"], {"Astrid": 1})

    def test_tames_named_tames_and_pets(self):
        w = World().tame("Wolf", 50, 60, name="Fenrir", TamedNameAuthor="Steam_1", follow="Ragnar", level=3,
                         spawntime=123 * vw.TICKS, health=80.4, max_health=100.0)
        w.tame("Wolf", 0, 0).tame("Lox", 1, 1, name="Bess", HaveSaddle=1)
        w.tame("Skeleton_Friendly", 2, 2).obj("Boar", 3, 3, health=10.0)  # summoned, wild
        s = snap(w)
        self.assertEqual((s["tames"], s["named_tames"]), ([["Wolf", 2], ["Lox", 1]], [["Bess", "Lox"], ["Fenrir", "Wolf"]]))
        self.assertEqual(s["pets"][0], {"k": f"Wolf:{123 * vw.TICKS}", "s": "Wolf", "x": 50, "z": 60, "lv": 2, "born": 123,
                                        "n": "Fenrir", "by": "Steam_1", "f": "Ragnar", "hp": 80, "max": 100})
        self.assertEqual((s["pets"][1]["born"], s["pets"][2]["saddle"]), (None, True))

    def test_portal_tags_and_map_portals_snapped_to_zone(self):
        s = snap(World().portal("home", 100, -30).portal("home", -70, 500).portal("mine", 0, 0).portal("", 10, 10))
        self.assertEqual(s["portals"], [["home", 2], ["", 1], ["mine", 1]])
        self.assertEqual(s["map"]["portals"], [["", 0, 0], ["home", -64, 512], ["home", 128, 0], ["mine", 0, 0]])

    def test_beds_per_owner(self):
        players = {}
        s = snap(World().bed(1001, "Ragnar").bed(1001, "Ragnar", 500, 500).bed(1002, "Astrid", prefab="piece_bed02"), players)
        self.assertEqual(s["beds"], {"Ragnar": 2, "Astrid": 1})
        self.assertEqual(players, {1001: "Ragnar", 1002: "Astrid"})  # learned from the owner fields

    def test_tombstone_inventory_and_time_of_death(self):
        w = World().tombstone("Astrid", [("Wood", 20), item("SwordIron", quality=3, crafter="Astrid", cid=1002)], died=4321,
                              x=-100, z=70)
        w.tombstone("Astrid", [("Wood", 5), ("Wood", 7)], died=9000)
        s = snap(w)
        self.assertEqual(s["tombstones"], {"Astrid": 2})
        self.assertEqual(s["map"]["tombs"], [["Astrid", -128, 64, 4321, [["Wood", 20, 1], ["SwordIron", 1, 3]]],
                                             ["Astrid", 0, 0, 9000, [["Wood", 12, 1]]]])
        self.assertEqual((s["items"]["Wood"]["tomb"], s["containers"], s["crafted"]), ([[-128, 64, 20], [0, 0, 12]], 0, {}))

    def test_signs_text_only(self):
        s = snap(World().sign("  Ragnar's hall ").sign("x" * 300).sign("   ").sign("Way home", author="Steam_76561190000000099"))
        self.assertEqual(s["signs"], ["Ragnar's hall", "Way home", "x" * 200])
        self.assertNotIn("Steam_", json.dumps({k: v for k, v in s.items() if k != "_explored"}))

    def test_shared_map_explored_merged_player_pins_only(self):
        w = World().table([1, 0, 0, 0], [("Home ", 1, 10, 10), ("Eikthyr", 9, 300, 300)])
        w.table([0, 0, 1, 0], [("Home", 1, 20, -20), ("Ore", 2, -100, 70)])
        s = snap(w)
        self.assertEqual(s["_explored"], {"size": 2, "px": vw.MAP_PX, "cells": b"\1\0\1\0"})
        self.assertEqual(s["map"]["pins"], [["Home", "house", 0, 0], ["Ore", "hammer", -128, 64]])  # same pin, same zone: once

    def test_no_table_no_explored(self):
        self.assertNotIn("_explored", snap(World().piece("wood_wall")))

    def test_boss_keys_to_bosses(self):
        s = snap(World().keys(["defeated_bonemass", "defeated_eikthyr", "KilledTroll"]))
        self.assertEqual(s["keys"], ["KilledTroll", "defeated_bonemass", "defeated_eikthyr"])
        self.assertEqual([n for _, n, done in s["bosses"] if done], ["Eikthyr", "Bonemass"])
        self.assertEqual(len(s["bosses"]), len(vw.BOSSES))

    def test_map_locations_only_when_placed(self):
        w = World().location("Eikthyrnir", 300.4, -200.6).location("GDKing", 5000, 5000, placed=False)
        w.location("Crypt3", 10, 10).location("Runestone_Meadows", 1, 1)  # not a map landmark
        s = snap(w)
        self.assertEqual(s["map"]["locations"], [["altar", "Eikthyr", 300, -201, "Eikthyrnir"],
                                                 ["dungeon", "Burial chambers", 10, 10, "Crypt3"]])
        self.assertEqual(s["boss_altars"], {"Eikthyrnir": 1})

    def test_zones_generated(self):
        self.assertEqual(snap(World().generated((0, 0), (1, 0), (-3, 120)))["zones"], 3)
        self.assertEqual(snap(World())["zones"], 0)

    def test_world_clock(self):
        s = snap(World(net_time=12345.678, save=9))
        self.assertEqual((s["net_time"], s["save"], s["schema"]), (12345.7, 9, vw.SCHEMA))

    def test_stations_and_kitchen(self):
        w = World(net_time=10_000.0).obj("smelter", queued=5, fuel=0.0, SpawnAmount=2).obj("smelter", creator=1001)
        w.obj("fermenter", Content="Mead", StartTime=1000 * vw.TICKS).obj("fermenter", Content="Mead", StartTime=9000 * vw.TICKS)
        w.obj("piece_beehive", level=3).obj("piece_cookingstation", creator=1001, slot0="CookedMeat", slotstatus0=1,
                                            slot1="CookedMeat", slotstatus1=2, slot2="RawMeat", slotstatus2=0)
        s = snap(w)
        self.assertEqual(s["stations"], {"fermenter": {"n": 2, "ready": 1, "busy": 1},
                                         "piece_beehive": {"n": 1, "out": 3, "ready": 1},
                                         "piece_cookingstation": {"n": 1, "busy": 1, "ready": 1, "burnt": 1},
                                         "smelter": {"n": 2, "queue": 5, "out": 2, "busy": 1, "nofuel": 1}})
        self.assertEqual(s["kitchen"], {"Ragnar": {"done": 1, "burnt": 1}})

    def test_bases_need_enough_pieces(self):
        w = World()
        for _ in range(40):
            w.piece("wood_wall", 0, 0, creator=1001)
        for _ in range(15):
            w.piece("wood_wall", 64, 64, creator=1002)  # neighbouring zone: same base
        for _ in range(49):
            w.piece("wood_wall", 3000, 3000, creator=1002)  # an outpost
        w.piece("piece_chest_wood", 64, 64, creator=1002, items=[("Wood", 30)])
        self.assertEqual(snap(w)["map"]["bases"], [{"x": 0, "z": 0, "zones": 2, "pieces": 56, "chests": 1, "items": 30,
                                                    "builders": [("Ragnar", 40), ("Astrid", 16)]}])

    def test_json_serialisable_apart_from_explored(self):
        w = World().keys(["defeated_eikthyr"]).location("Eikthyrnir", 1, 1).generated((0, 0))
        w.piece("piece_chest_wood", creator=1001, items=[item("SwordIron", quality=2, crafter="Astrid", cid=1002)])
        w.stand("itemstand", 0, 0, "SwordIron").tame("Wolf", name="Fenrir").portal("home").bed(1001, "Ragnar")
        w.tombstone("Astrid", [("Wood", 1)], died=10).sign("hi").table([1, 0, 0, 1], [("Home", 1, 0, 0)]).obj("smelter", queued=1)
        s = snap(w)
        explored = s.pop("_explored")
        self.assertIsInstance(explored["cells"], bytes)
        back = json.loads(json.dumps(s))
        self.assertEqual(set(back), set(s))
        self.assertTrue(all(isinstance(k, str) for k in back["items"]))


if __name__ == "__main__":
    unittest.main()
