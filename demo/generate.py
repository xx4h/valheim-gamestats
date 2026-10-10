#!/usr/bin/env python3
"""The demo: seven made-up Vikings on a made-up world for ~350 in-game days, through the real collector.

    python3 demo/generate.py OUT [--days 350] [--seed 7] [--end <unix time>] [--gamedata DIR]

Nothing here is real. A seeded simulation plays the server — sessions, combat, gathering, exploration, raids, boss
fights, deaths, sleeps, restarts — and writes the events the plugin would have written; world saves every few days
(tests/collector/worldsave.py) hold what was built, stored, tamed and mapped; a terrain sample gives the map. Then the
collector does what it does on a real server (collector.build, world_update, terrain_update), and OUT gets the page as
a static site: site/ plus index.json, c/, terrain.png and explored.png — what CI publishes to GitHub Pages and what the
README's showcase is recorded from. The same seed gives the same history; --end (default: now) moves it in time.
--gamedata is what tools/extract_gamedata.py and render_looks.py made from the game's files (item icons, items.json,
creatures.json, looks/): it goes to OUT/icons/valheim/ as on a real server, for the icons and the figures. Without it the
page draws what it does without them.

Stdlib only (plus the collector and the test helpers in this repository).
"""
import argparse
import contextlib
import gzip
import io
import json
import math
import os
import random
import shutil
import struct
import sys
import tempfile
import time
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path[:0] = [os.path.join(ROOT, "collector"), os.path.join(ROOT, "tests", "collector")]

from worldsave import World, item  # noqa: E402

from valheim_gamestats import collector  # noqa: E402

TZ = ZoneInfo("Europe/Berlin")
DAY_LEN, MORNING = 1800, 0.15  # the world clock: seconds per in-game day, where a day starts
BLOCK = 600  # the simulation's step: ten minutes
SERVER = {"id": "demo", "title": "Demo Valheim", "game": "valheim", "rcon": {"host": "demo", "password_env": "X"},
          "world": {"path": "", "dir": "worlds_local", "manifest": "manifest", "interval": 3600},
          "support": {"url": "https://github.com/xx4h/valheim-gamestats", "label": "valheim-gamestats on GitHub",
                      "text": "This is a demo with made-up players. Run it for your own server: it's free and open source."}}
CFG = {"interval": 60, "tz": "Europe/Berlin", "servers": [SERVER]}

# Who plays how. hours: a session's typical length; days: chance to play on a weekday / at the weekend; at: when they
# like to start (local hours — mostly evenings, together: the world clock only runs while someone is on, so a group
# playing at once is what fills a world with players); then how much of each they do (0–1), when they join and leave
# (share of the period).
PLAYERS = [
    {"p": "Ragnar", "hours": 2.2, "days": (0.6, 0.8), "at": (19.5, 20.5), "build": 0.4, "explore": 0.9, "fight": 0.8,
     "dies": 0.8},
    {"p": "Astrid", "hours": 2.6, "days": (0.65, 0.8), "at": (19, 20), "build": 1.0, "explore": 0.3, "fight": 0.4, "dies": 0.3},
    {"p": "Bjorn", "hours": 2.4, "days": (0.5, 0.75), "at": (20, 21.5), "build": 0.3, "explore": 0.5, "fight": 1.0, "dies": 1.0},
    {"p": "Sigrid", "hours": 2.0, "days": (0.35, 0.85), "at": (19.5, 20.5), "build": 0.5, "explore": 1.0, "fight": 0.5,
     "dies": 0.5},
    {"p": "Leif", "hours": 1.0, "days": (0.35, 0.4), "at": (20, 22), "build": 0.2, "explore": 0.3, "fight": 0.6, "dies": 1.2},
    {"p": "Freydis", "hours": 2.8, "days": (0.6, 0.7), "at": (20, 21), "build": 0.7, "explore": 0.6, "fight": 0.9, "dies": 0.6,
     "from": 0.25},
    {"p": "Ivar", "hours": 1.4, "days": (0.5, 0.5), "at": (19, 21), "build": 0.3, "explore": 0.6, "fight": 0.5, "dies": 0.7,
     "until": 0.55},
]
STEAM = {p["p"]: f"Steam_7656119000000{i + 10:04d}" for i, p in enumerate(PLAYERS)}  # invented, like the tests'

# The world, biome by biome: from which in-game day, its creatures (name, health), what's gathered, its trees and
# rocks, its locations, its raids, the weapons of the time, its boss (prefab, altar, key, health).
STAGES = [
    {"day": 0, "biome": "Meadows", "mobs": [("Greyling", 40), ("Boar", 10), ("Neck", 5), ("Deer", 10)],
     "pick": ["Wood", "Stone", "Flint", "Raspberry", "Mushroom", "Dandelion", "Feathers", "LeatherScraps", "DeerHide"],
     "fell": ["Beech1", "Bush01"], "mine": ["Rock4"], "locs": ["WoodHouse1", "Runestone_Meadows", "ShipWreck01"],
     "dungeons": [], "raids": ["army_eikthyr"], "weapons": ["Club", "AxeFlint", "Bow"],
     "boss": ("Eikthyr", "Eikthyrnir", "defeated_eikthyr", 500, 12)},
    {"day": 15, "biome": "Black Forest", "mobs": [("Greydwarf", 40), ("Greydwarf_Elite", 120), ("Troll", 600), ("Skeleton", 60)],
     "pick": ["Resin", "Blueberries", "CopperOre", "TinOre", "GreydwarfEye", "Thistle", "Carrot"],
     "fell": ["Pine", "FirTree", "Birch"], "mine": ["MineRock_Copper", "MineRock_Tin"],
     "locs": ["Crypt3", "TrollCave02", "Vendor_BlackForest", "Hildir_camp", "Runestone_BlackForest"],
     "dungeons": ["Crypt3", "TrollCave02"], "raids": ["army_theelder", "foresttrolls", "skeletons"],
     "weapons": ["SwordBronze", "AxeBronze", "BowFineWood", "MaceBronze"],
     "boss": ("gd_king", "GDKing", "defeated_gdking", 2500, 45)},
    {"day": 55, "biome": "Swamp", "mobs": [("Draugr", 100), ("Draugr_Elite", 200), ("Blob", 50), ("Leech", 60), ("Wraith", 100)],
     "pick": ["IronScrap", "Guck", "Entrails", "Ooze", "Bloodbag", "Turnip"], "fell": ["SwampTree1", "Oak1"],
     "mine": ["MineRock_Iron"], "locs": ["SunkenCrypt4", "SwampHut1", "BogWitch_Camp"], "dungeons": ["SunkenCrypt4"],
     "raids": ["army_bonemass", "blobs"], "weapons": ["MaceIron", "SwordIron", "AtgeirIron", "BowHuntsman"],
     "boss": ("Bonemass", "Bonemass", "defeated_bonemass", 5000, 95)},
    {"day": 110, "biome": "Mountains", "mobs": [("Wolf", 80), ("Hatchling", 100), ("StoneGolem", 1000), ("Fenring", 150)],
     "pick": ["SilverOre", "Obsidian", "WolfPelt", "FreezeGland", "Crystal", "DragonEgg"], "fell": [],
     "mine": ["MineRock_Silver"],
     "locs": ["MountainCave02", "DrakeNest01", "Dragonqueen", "Hildir_cave"], "dungeons": ["MountainCave02", "Hildir_cave"],
     "raids": ["army_moder", "wolves"], "weapons": ["SwordSilver", "SpearWolfFang", "BowDraugrFang", "MaceSilver"],
     "boss": ("Dragon", "Dragonqueen", "defeated_dragon", 7500, 160)},
    {"day": 175, "biome": "Plains", "mobs": [("Goblin", 175), ("GoblinBrute", 800), ("Deathsquito", 10), ("Lox", 1000)],
     "pick": ["BlackMetalScrap", "Barley", "Flax", "Cloudberry", "Tar", "LoxPelt", "Needle"], "fell": [],
     "mine": ["MineRock_Meteorite"], "locs": ["GoblinCamp2", "TarPit1", "StoneHenge1", "GoblinKing", "Hildir_plainsfortress"],
     "dungeons": ["Hildir_plainsfortress"], "raids": ["army_goblin", "surtlings"],
     "weapons": ["SwordBlackmetal", "AtgeirBlackmetal", "BowDraugrFang", "AxeBlackMetal"],
     "boss": ("GoblinKing", "GoblinKing", "defeated_goblinking", 10000, 235)},
    {"day": 250, "biome": "Mistlands", "mobs": [("Seeker", 200), ("SeekerBrute", 2000), ("Tick", 50), ("Gjall", 1000),
                                               ("Dverger", 300)],
     "pick": ["BlackMarble", "Softtissue", "Sap", "YggdrasilWood", "MushroomJotunPuffs", "Carapace"], "fell": ["YggaShoot1"],
     "mine": ["giant_helmet1_destruction"], "locs": ["Mistlands_DvergrTownEntrance1", "Mistlands_DvergrBossEntrance1",
                                                    "Mistlands_Giant1"],
     "dungeons": ["Mistlands_DvergrTownEntrance1"], "raids": ["army_seekers", "army_gjall", "bats"],
     "weapons": ["SwordMistwalker", "CrossbowArbalest", "KnifeSkollAndHati", "AtgeirHimminAfl"],
     "boss": ("SeekerQueen", "Mistlands_DvergrBossEntrance1", "defeated_queen", 12500, 320)},
    {"day": 340, "biome": "Ashlands", "mobs": [("Charred_Melee", 500), ("Morgen", 2500), ("Asksvin", 400)],
     "pick": ["Grausten", "CharredBone", "SulfurStone", "Fiddleheadfern"], "fell": ["AshlandsTree1"],
     "mine": ["MineRock_Flametal"],
     "locs": ["CharredFortress", "MorgenHole1", "FaderLocation"], "dungeons": ["MorgenHole1"], "raids": ["army_charred"],
     "weapons": ["SwordNiedhogg", "AxeBerzerkr", "BowAshlands"], "boss": None},
]
PIECES = [  # what gets built, stage by stage (prefab, share)
    [("woodwall", 6), ("wood_floor", 5), ("wood_roof", 4), ("wood_beam", 3), ("wood_pole", 2), ("fire_pit", 1),
     ("piece_workbench", 1), ("piece_chest_wood", 1), ("wood_door", 1), ("piece_groundtorch_wood", 1)],
    [("stake_wall", 3), ("wood_stair", 1), ("forge", 1), ("piece_chest", 1), ("wood_wall_half", 2), ("piece_bench01", 1)],
    [("stone_wall_2x1", 4), ("stone_floor_2x2", 2), ("piece_cauldron", 1), ("smelter", 1), ("charcoal_kiln", 1),
     ("piece_chair", 1), ("piece_table", 1)],
    [("darkwood_roof", 3), ("darkwood_beam", 2), ("iron_grate", 1), ("piece_walltorch", 2), ("rug_wolf", 1), ("bed", 1)],
    [("darkwood_wall", 3), ("piece_spinningwheel", 1), ("windmill", 1), ("piece_brazierceiling01", 1), ("piece_throne01", 1),
     ("blastfurnace", 1)],
    [("blackmarble_floor", 3), ("blackmarble_column_1", 2), ("piece_dvergr_lantern", 1), ("piece_magetable", 1),
     ("piece_chest_blackmetal", 1)],
    [("ashwood_wall", 2), ("grausten_floor_2x2", 2), ("piece_Lavalantern", 1)],
]
REPEATS = ("Crypt", "Troll", "Sunken", "Mountain", "Goblin", "Tar", "Ship")  # locations there are many of
SIGNS = ["Welcome to Ironhold", "Mead hall — no trolls", "Ragnar's hut (keep out)", "Portal hub", "Smelters: feed me coal",
         "Here lies Leif's dignity", "Fish market", "Lox pen", "Do not open: angry bees"]
TAMES = [("Wolf", "Fenrir"), ("Wolf", "Skoll"), ("Boar", "Bacon"), ("Lox", "Bessie"), ("Lox", "Thunderhoof"), ("Wolf", None),
         ("Boar", None), ("Asksvin", "Ember")]
# What they wear, stage by stage (the hands: the stage's weapons, a shield on the left). A slot left out keeps what it had.
GEAR = [
    {"helmet": "HelmetLeather", "chest": "ArmorLeatherChest", "legs": "ArmorLeatherLegs", "shoulder": "CapeDeerHide",
     "left": "ShieldWood"},
    {"helmet": "HelmetBronze", "chest": "ArmorBronzeChest", "legs": "ArmorBronzeLegs", "shoulder": "CapeTrollHide",
     "left": "ShieldBronzeBuckler", "trinket": "TrinketBronzeHealth"},
    {"helmet": "HelmetIron", "chest": "ArmorIronChest", "legs": "ArmorIronLegs", "left": "ShieldBanded",
     "trinket": "TrinketIronHealth"},
    {"helmet": "HelmetDrake", "chest": "ArmorWolfChest", "legs": "ArmorWolfLegs", "shoulder": "CapeWolf", "left": "ShieldSilver",
     "trinket": "TrinketIronStamina"},
    {"helmet": "HelmetPadded", "chest": "ArmorPaddedCuirass", "legs": "ArmorPaddedGreaves", "shoulder": "CapeLinen",
     "left": "ShieldBlackmetal", "utility": "BeltStrength"},
    {"helmet": "HelmetCarapace", "chest": "ArmorCarapaceChest", "legs": "ArmorCarapaceLegs", "shoulder": "CapeFeather",
     "left": "ShieldCarapace", "utility": "Demister"},
    {"helmet": "HelmetFlametal", "chest": "ArmorFlametalChest", "legs": "ArmorFlametalLegs", "shoulder": "CapeAsh",
     "left": "ShieldFlametal"},
]
SYNCED = ("right", "left", "rightBack", "leftBack", "shoulder")  # the slots whose level the game shares (rcon.py)
# How they look (plugin "look": body model 0 male / 1 female, skin and hair tint, hair and beard item)
LOOKS = {"Ragnar": (0, 0.3, (1, 0.931, 0.706), "Hair6", "Beard1"),
         "Astrid": (1, 0.65, (0.55, 0.39, 0.271), "Hair19", "BeardNone"),
         "Bjorn": (0, 0.373, (0.36, 0.22, 0.12), "Hair18", "Beard18"),
         "Sigrid": (1, 0.759, (0.598, 0.297, 0.172), "Hair30", "BeardNone"),
         "Leif": (0, 0.487, (0.743, 0.691, 0.524), "Hair38", "Beard24"),
         "Freydis": (1, 0.55, (0.2, 0.15, 0.12), "Hair12", "BeardNone"),
         "Ivar": (0, 0.42, (0.85, 0.85, 0.82), "Hair3", "Beard10")}


class Sim:
    def __init__(self, seed, end, days, scale):
        self.r = random.Random(seed)
        self.end, self.days, self.scale = end, days, scale
        self.start = end - days * 86400
        self.ev = []
        self.world_time = DAY_LEN * MORNING  # the world clock runs while someone is online
        self.uids = {p["p"]: 1001 + i for i, p in enumerate(PLAYERS)}
        self.zones, self.pos = {}, {}  # discovered zones; where each explorer is (x, z, heading)
        self.keys, self.boss_done = [], set()
        self.deaths = []  # (t, player, x, z)
        self.saves = []   # (t, World)
        self.built = {p["p"]: [] for p in PLAYERS}  # (prefab, x, z)
        self.bases = {p["p"]: self.near(0, 0, 300) for p in PLAYERS}
        self.locations = {}  # name -> (x, z)
        self.zdos = 90_000
        # gear (equipment.json, the plugin's equipment poll): its own dice, so the rest of the history stays as it was
        self.gr = random.Random(seed + 1)
        self.gear, self.seen, self.usage, self.levels = {}, {}, {}, {}  # worn now; last poll; history; item levels

    def add(self, t, **e):
        e.setdefault("p", "")
        e.setdefault("i", "")
        e.setdefault("n", 1)
        e["t"] = float(t)
        self.ev.append(e)

    def near(self, x, z, d):
        a, r = self.r.uniform(0, 2 * math.pi), self.r.uniform(0, d)
        return x + r * math.cos(a), z + r * math.sin(a)

    def day(self):
        return int((self.world_time - DAY_LEN * MORNING) // DAY_LEN)

    def stage(self):
        d = self.day()
        return max(i for i, s in enumerate(STAGES) if d >= s["day"])

    # ---- the plan: who plays when -----------------------------------------------------------------------------------
    def plan(self):
        sessions = []
        for d in range(self.days):
            midnight = datetime.fromtimestamp(self.start + d * 86400, TZ).replace(hour=0, minute=0, second=0)
            weekend = midnight.weekday() >= 5
            for p in PLAYERS:
                if d < p.get("from", 0) * self.days or d >= p.get("until", 1) * self.days:  # shares of the period
                    continue
                if self.r.random() > min(0.95, p["days"][weekend] * self.scale):
                    continue
                for _ in range(1 + (self.r.random() < 0.15)):  # now and then a second session that day
                    h = self.r.uniform(*p["at"]) + self.r.gauss(0, 1.0) + (self.r.random() < 0.1) * self.r.uniform(-8, 3)
                    s = midnight.timestamp() + (h % 24) * 3600
                    length = max(4 * 60, min(9 * 3600, self.r.lognormvariate(math.log(p["hours"] * 3600), 0.6)))
                    if self.r.random() < 0.06:
                        length = self.r.uniform(60, 280)  # a ghost visit
                    sessions.append([max(self.start + 600, s), p["p"]])
                    sessions[-1].append(min(self.end + 7200, sessions[-1][0] + length))
        # this evening: two of them are still on (the page shows who's online)
        for p, ago in (("Astrid", 50 * 60), ("Bjorn", 20 * 60)):
            sessions.append([self.end - ago, p, self.end + 3 * 3600])
        sessions.sort()
        # one player at a time per character: later overlapping sessions of the same character are dropped
        out, until = [], {}
        for s, p, e in sessions:
            if s >= until.get(p, 0) + 120:
                out.append((s, p, e))
                until[p] = e
        return out

    # ---- the run ---------------------------------------------------------------------------------------------------
    def run(self):
        sessions = self.plan()
        restarts = [self.start + d * 86400 + 4.5 * 3600 for d in range(3, self.days, 7)]  # weekly, at night
        self.boot(self.start)
        t = self.start
        online, joined, idx = {}, {}, 0  # who's on until when; since when
        next_save = self.start + 3 * 86400
        while t < self.end:
            t_next = t + BLOCK
            if restarts and restarts[0] < t_next:
                rt = restarts.pop(0)
                for p in list(online):
                    online.pop(p)
                self.add(rt, e="stop")
                self.boot(rt + 120)
            while idx < len(sessions) and sessions[idx][0] < t_next:
                s, p, e = sessions[idx]
                idx += 1
                if p not in online:
                    self.join(s, p)
                    online[p] = e
                    joined[p] = s
            for p, e in list(online.items()):
                if e < t_next and e <= self.end:
                    self.add(e, e="logout", p=p, uid=self.uids[p])
                    online.pop(p)
            if online:
                self.world_time += BLOCK
                # in this step: whoever was on at its start (who joins during it plays from the next one)
                if (on := sorted(p for p in online if joined[p] <= t)):
                    self.block(t, on)
            if t >= next_save or t_next >= self.end:
                self.saves.append((min(t_next, self.end), self.snapshot()))
                next_save += self.r.uniform(2, 4) * 86400
            self.zdos += len(online) * self.r.randint(20, 120)
            self.add(t + 599, e="server", n=len(online), zdos=self.zdos, time=round(self.world_time, 1))
            t = t_next
        return online

    def boot(self, t):
        self.add(t - 30, e="plugin", i="1.22.2", hooks=15, of=15, failed=[])
        self.add(t, e="start", i="Midgard", game="l-1.0.17", backend="PlayFab")
        self.add(t + 20, e="lobby", i="active", code=f"{self.r.randint(100000, 999999)}")

    def join(self, t, p):
        uid = self.uids[p]
        self.add(t, e="login", p=p, i=STEAM[p], uid=uid)
        self.add(t + 25, e="spawn", p=p, uid=uid)

    # ---- ten minutes of play -----------------------------------------------------------------------------------------
    def block(self, t, players):
        r, st = self.r, self.stage()
        stage = STAGES[st]
        local = datetime.fromtimestamp(t, TZ)
        frac = (self.world_time / DAY_LEN) % 1
        if frac > 0.8 and r.random() < 0.7:  # night: off to bed
            morning = (math.floor(self.world_time / DAY_LEN) + 1 + MORNING) * DAY_LEN
            self.add(t + 300, e="sleep", time=round(self.world_time, 1), to=round(morning, 1))
            for p in players:
                self.add(t + 300, e="bed", p=p)
            self.world_time = morning
        if r.random() < 0.035 * len(players) ** 0.5:
            self.raid(t, players, stage)
        # the first boss still standing, once its day has come and there's a crew
        boss = next((s["boss"] for s in STAGES if s["boss"] and s["boss"][0] not in self.boss_done), None)
        if boss and self.day() >= boss[4] and len(players) >= 2 and r.random() < 0.3:
            self.fight(t, players, boss, st)
        for p in players:
            self.play(t, p, PLAYERS[[x["p"] for x in PLAYERS].index(p)], st, local, players)
            self.wear(t + BLOCK, p, st)

    def play(self, t, p, me, st, local, players):
        r, stage = self.r, STAGES[st]
        pool = [m for s in STAGES[max(0, st - 1):st + 1] for m in s["mobs"]]
        weapons = stage["weapons"] + STAGES[max(0, st - 1)]["weapons"][:1]
        at = lambda: t + r.uniform(5, BLOCK - 5)
        # combat
        for _ in range(self.poisson(1.8 * me["fight"])):
            mob, hp = r.choice(pool)
            stars = r.choices([0, 1, 2], [85, 12, 3])[0]
            name = mob + (f"*{stars}" if stars else "")
            w = r.choice(weapons)
            dmg = hp * (stars + 1)
            ts = at()
            self.add(ts, e="dmg", p=p, i=name, n=dmg)
            self.add(ts, e="dw", p=p, i=f"{w}>{name}", n=dmg)
            self.add(ts, e="wdmg", p=p, i=w, n=dmg)
            self.add(ts, e="kill", p=p, i=name)
            self.add(ts, e="kw", p=p, i=f"{w}>{name}")
            self.add(ts, e="wkill", p=p, i=w)
        if r.random() < 0.5 * me["fight"]:
            hits = r.randint(1, 6)
            self.add(at(), e="taken", p=p, n=hits * r.randint(5, 20 + 15 * st))
            self.add(at(), e="hit", p=p, n=hits)
        # gathering
        for _ in range(self.poisson(2.5)):
            self.add(at(), e="pick", p=p, i=r.choice(stage["pick"] + STAGES[0]["pick"][:2]), n=r.randint(1, 20))
        if stage["fell"] and r.random() < 0.4 + 0.4 * me["build"]:
            self.add(at(), e="fell", p=p, i=r.choice(stage["fell"] + STAGES[0]["fell"]), n=r.randint(1, 6))
        if r.random() < 0.3:
            self.add(at(), e="mine", p=p, i=r.choice(stage["mine"]), n=r.randint(1, 3))
        # moving about
        dist = r.uniform(200, 900) * (0.5 + me["explore"])
        self.add(at(), e="dist", p=p, i="foot", n=round(dist))
        if r.random() < 0.15:
            self.add(at(), e="dist", p=p, i="boat", n=round(r.uniform(300, 2500)))
        if r.random() < 0.1:
            self.add(at(), e="dist", p=p, i="swim", n=round(r.uniform(20, 200)))
        if st >= 4 and r.random() < 0.1:
            self.add(at(), e="dist", p=p, i="ride", n=round(r.uniform(100, 800)))
        self.add(at(), e="crouch", p=p, n=r.randint(0, 40))
        if r.random() < 0.25:
            self.add(at(), e="exhn", p=p, n=r.randint(1, 3))
            self.add(at(), e="exh", p=p, n=r.randint(3, 30))
        if r.random() < 0.08:
            self.add(at(), e="emote", p=p, i=r.choice(["wave", "dance", "cheer", "thumbsup", "point"]))
        hp = 25 + 22 * st + r.uniform(0, 30)
        self.add(at(), e="peak", p=p, i="hp", n=round(hp, 1))
        self.add(at(), e="peak", p=p, i="st", n=round(50 + 20 * st + r.uniform(0, 40), 1))
        self.add(at(), e="peak", p=p, i="y", n=round(r.uniform(32, 120 + (180 if stage["biome"] == "Mountains" else 0)), 1))
        self.add(at(), e="peak", p=p, i="v_foot", n=round(r.uniform(6.5, 9.5), 2))
        if r.random() < 0.3:
            self.add(at(), e="peak", p=p, i="hit", n=round(r.uniform(5, 30 + 25 * st), 1))
        if r.random() < 0.05:
            self.add(at(), e="sprint", p=p, m=round(r.uniform(40, 400), 1), s=round(r.uniform(5, 50), 1))
        if r.random() < 0.02:
            self.add(at(), e="fall", p=p, h=round(r.uniform(8, 45), 1))
        # exploring
        for _ in range(self.poisson(3 * me["explore"] + 0.2)):
            self.explore(at(), p, st, players)
        if stage["dungeons"] and r.random() < 0.06 * (me["explore"] + me["fight"]):
            loc = r.choice(stage["dungeons"])
            x, z = self.locations.get(loc) or self.near(0, 0, 1500 + 1200 * st)
            s = r.randint(240, 1500)
            ts = at()
            self.add(ts, e="enter", p=p, i=loc, x=round(x), z=round(z))
            self.add(ts + s, e="leave", p=p, i=loc, x=round(x), z=round(z), s=s)
            self.add(ts + s - 30, e="loot", p=p, i=r.choice(["Coins", "Amber", "Ruby", "AmberPearl", "SilverNecklace"]),
                     n=r.randint(1, 60))
        # building: counted into the next world save
        for _ in range(self.poisson(3 * me["build"])):
            prefab = self.pick_piece(st)
            bx, bz = self.bases[p]
            self.built[p].append((prefab, *self.near(bx, bz, 60)))
        if r.random() < 0.02 * me["build"]:
            self.bases[p] = self.near(*self.bases[p], 400 + 300 * st)  # a new outpost
        # gear: what they made goes into chests and onto them
        if r.random() < 0.05:
            ts, w = at(), r.choice(stage["weapons"])
            x, z = self.bases[p]
            self.add(ts, e="take", p=p, i=w, q=r.randint(1, 4), c=r.choice(list(self.uids)), k="chest", x=round(x), z=round(z))
            self.add(ts + 5, e="on", p=p, i=w, q=r.randint(1, 4), c=p, k="", x=round(x), z=round(z))
        # pets
        if r.random() < 0.01:
            kind, name = r.choice([x for x in TAMES if x[1]])
            k = f"{kind}:{1000 + TAMES.index((kind, name))}"
            self.add(at(), e="pethp", p=name, i=kind, k=k, dmg=r.randint(5, 80), hits=r.randint(1, 4), heal=0, min=20, hp=60,
                     max=200, by={f"~{r.choice(pool)[0]}": 30})
        # dying
        if r.random() < 0.035 * me["dies"] * (1 + 0.3 * st):
            ts = at()
            if r.random() < 0.3:
                self.add(ts - 40, e="closecall", p=p, hp=round(r.uniform(0.5, 9), 1), max=round(hp))
            self.add(ts, e="death", p=p)
            self.deaths.append((ts, p, *self.near(*self.bases[p], 800 + 400 * st)))
            self.add(ts + 30, e="spawn", p=p, uid=self.uids[p])
        elif r.random() < 0.01:
            self.add(at(), e="closecall", p=p, hp=round(r.uniform(0.5, 9), 1), max=round(hp))

    def wear(self, t, p, st):
        """Ten minutes in their gear: each piece follows the stage a while after it arrives, the hands hold a weapon of
        the time and a shield (or carry them on the back); the poll adds the time to the gear history like rcon.py."""
        r = self.gr
        worn = self.gear.setdefault(p, {})  # slot -> stage of the piece they have
        for slot in {k for g in GEAR[:st + 1] for k in g}:
            newest = max(i for i in range(st + 1) if slot in GEAR[i])
            if slot not in worn or (worn[slot] < newest and r.random() < 0.08):
                worn[slot] = newest
        weapons = STAGES[st]["weapons"]
        w = worn.get("weapon")
        if w is None or (w not in weapons and r.random() < 0.08) or r.random() < 0.03:  # catching up, or a change
            worn["weapon"] = r.choice(weapons)
        back = r.random() < 0.35  # walking about with the hands free
        gear = {slot: GEAR[i][slot] for slot, i in worn.items() if slot not in ("weapon", "left")}
        gear["rightBack" if back else "right"] = worn["weapon"]
        gear["leftBack" if back else "left"] = GEAR[worn["left"]]["left"]
        slots = {}
        for slot, it in gear.items():
            s = {"item": it}
            if slot in SYNCED:
                s["q"] = self.levels.setdefault((p, it), r.randint(1, 4))
            slots[slot] = s
            u = self.usage.setdefault(p, {}).setdefault(slot, {}).setdefault(it, {"f": t, "l": t, "s": 0})
            u["l"], u["s"] = t, u["s"] + BLOCK
            if s.get("q"):
                u["q"] = max(u.get("q", 0), s["q"])
        m, skin, hair, h, b = LOOKS[p]
        self.seen[p] = {"t": t, "slots": slots, "look": {"m": m, "skin": [skin] * 3, "hair": list(hair), "h": h, "b": b}}

    def equipment(self, online):
        """equipment.json as the collector's poll leaves it (rcon.py): last seen gear, who is on now, the gear history."""
        last = {p: {**v, "t": min(v["t"], self.end)} for p, v in self.seen.items()}
        cap = lambda items: {it: {**u, "l": min(u["l"], self.end)} for it, u in items.items()}
        return {"ok": self.end, "online": sorted(online), "players": dict(sorted(last.items())),
                "usage": {p: {slot: cap(items) for slot, items in v.items()} for p, v in sorted(self.usage.items())}}

    def poisson(self, lam):
        n, p, limit = 0, 1.0, math.exp(-lam)
        while True:
            p *= self.r.random()
            if p <= limit:
                return n
            n += 1

    def pick_piece(self, st):
        opts = [x for s in PIECES[:st + 1] for x in s]
        return self.r.choices([x[0] for x in opts], [x[1] for x in opts])[0]

    def explore(self, t, p, st, players):
        """A stretch walked: the player moves on with momentum, outwards while inside what this stage reaches, home-ward
        beyond it; the world generates the zones around them (a 3×3 block) — the new ones are discoveries."""
        r = self.r
        reach = 1200 + 1000 * st + 6 * self.day()
        x, z, heading = self.pos.get(p) or (0.0, 0.0, r.uniform(0, 2 * math.pi))
        d = math.hypot(x, z)
        out = math.atan2(z, x) if d > 1 else heading
        if STAGES[st]["biome"] == "Ashlands" and r.random() < 0.5:
            out = -math.pi / 2  # the south
        pull = 0.25 if d < reach else -0.6  # outwards, or back towards home
        heading += r.gauss(0, 0.45) + pull * math.sin(out - heading)
        step = r.uniform(90, 200)
        x, z = x + step * math.cos(heading), z + step * math.sin(heading)
        if r.random() < 0.04:  # through a portal home
            x, z = self.near(0, 0, 200)
        self.pos[p] = (x, z, heading)
        cx, cz = int(x // 64), int(z // 64)
        new = [(cx + dx, cz + dz) for dx in (-1, 0, 1) for dz in (-1, 0, 1) if (cx + dx, cz + dz) not in self.zones]
        with_me = [p] + ([r.choice(players)] if r.random() < 0.25 else [])  # exploring together
        for i, (zx, zy) in enumerate(new):
            locs = []
            if not self.zones:
                locs = ["StartTemple"]
            elif r.random() < 0.012:
                name = r.choice(STAGES[st]["locs"])
                if name not in self.locations or name.startswith(REPEATS):
                    locs = [name]
                    self.locations.setdefault(name, (zx * 64 + 32, zy * 64 + 32))
            self.zones[(zx, zy)] = t
            self.add(t + i, e="zone", i=f"{zx},{zy}", by=sorted(set(with_me)), l=locs)

    def raid(self, t, players, stage):
        name = self.r.choice(stage["raids"] + STAGES[0]["raids"][:1] * (stage is STAGES[0]))
        self.add(t + 60, e="raid", i=name, near=players[: self.r.randint(1, len(players))])
        self.add(t + 60 + self.r.randint(150, 330), e="raidend", i=name)

    def fight(self, t, players, boss, st):
        prefab, altar, key, hp, _day = boss
        crew = players
        give_up = self.r.random() < 0.35 and prefab not in getattr(self, "tried", set())
        self.tried = getattr(self, "tried", set()) | {prefab}
        minutes = self.r.randint(4, 12)
        share = hp / len(crew) / minutes
        for m in range(minutes):
            for p in crew:
                w = self.r.choice(STAGES[st]["weapons"])
                d = round(share * self.r.uniform(0.5, 1.5) * (0.4 if give_up else 1))
                self.add(t + 60 * m + 30, e="dmg", p=p, i=prefab, n=d)
                self.add(t + 60 * m + 30, e="dw", p=p, i=f"{w}>{prefab}", n=d)
                self.add(t + 60 * m + 30, e="taken", p=p, n=self.r.randint(20, 120))
        if give_up:
            victim = self.r.choice(crew)
            self.add(t + 60 * minutes, e="death", p=victim)
            self.add(t + 60 * minutes + 30, e="spawn", p=victim, uid=self.uids[victim])
            return
        for p in crew:
            self.add(t + 60 * minutes + 40, e="kill", p=p, i=prefab)
            self.add(t + 60 * minutes + 40, e="kw", p=p, i=f"{STAGES[st]['weapons'][0]}>{prefab}")
        self.boss_done.add(prefab)
        self.keys.append(key)
        if prefab == "gd_king":
            self.keys.append("killedtroll")

    # ---- a world save ------------------------------------------------------------------------------------------------
    def snapshot(self):
        r = random.Random(len(self.saves))  # its own: saves don't change the simulation's dice
        w = World(net_time=self.world_time, save=len(self.saves) + 1)
        for p, pieces in self.built.items():
            uid = self.uids[p]
            for prefab, x, z in pieces:
                if prefab.startswith(("piece_chest", "piece_chest_wood")):
                    stored = [item(r.choice(["Wood", "Stone", "Resin", "CopperOre"]), r.randint(5, 50)),
                              item(r.choice(STAGES[0]["weapons"]), 1, r.randint(1, 4), p, uid)]
                    w.piece(prefab, x, z, creator=uid, items=stored)
                else:
                    w.piece(prefab, x, z, creator=uid)
            if pieces:
                bx, bz = self.bases[p]
                w.bed(uid, p, bx, bz)
        for i, (kind, name) in enumerate(TAMES[: 2 + len(self.saves) // 4]):
            w.tame(kind, *self.near(0, 0, 400), name=name, spawntime=1000 + i)
        tags = ["home", "mines", "swamp", "mountain", "plains", "mist"][: 1 + self.stage()]
        for tag in tags:
            w.portal(tag, *self.near(0, 0, 200))
            w.portal(tag, *self.near(0, 0, 1200 + 900 * tags.index(tag)))
        for i, text in enumerate(SIGNS[: 2 + len(self.saves) // 5]):
            w.sign(text, *self.near(0, 0, 300), creator=1001 + i % len(PLAYERS))
        for _t, p, x, z in self.deaths[-6:]:
            w.tombstone(p, [item("Wood", 20), item(r.choice(STAGES[self.stage()]["weapons"]), 1, 2)], self.world_time - 600, x, z,
                        owner_id=self.uids[p])
        size = 128
        explored = bytearray(size * size)
        for zx, zy in self.zones:
            c, row = int(zx * 64 / 160 + size / 2), int(size / 2 - zy * 64 / 160)
            for dc in (-1, 0, 1):
                for dr in (-1, 0, 1):
                    if 0 <= c + dc < size and 0 <= row + dr < size:
                        explored[(row + dr) * size + c + dc] = 1
        pins = [(f"{p}'s base", 1, *self.bases[p]) for p in self.uids if self.built[p]][:6]
        pins += [(n, 3, x, z) for n, (x, z) in list(self.locations.items())[:8]]
        w.table(bytes(explored), pins, 0, 0)
        w.stand("ArmorStand", 20, 20, "HelmetBronze", "ArmorBronzeChest", creator=1002)
        w.stand("itemstand", 25, 20, "TrophyEikthyr", creator=1001)
        w.keys(list(self.keys))
        for name, (x, z) in self.locations.items():
            w.location(name, x, z)
        for s in STAGES:
            if s["boss"] and s["boss"][1] not in self.locations:
                w.location(s["boss"][1], *self.near(0, 0, 2000 + 1500 * STAGES.index(s)), placed=True)
        w.generated(*list(self.zones))
        return w


def terrain(seed=42, size=256, extent=10500.0):
    """A made-up world for the map: an island ringed by biomes, Ashlands in the south, the Deep North in the north."""
    r = random.Random(seed)
    waves = [(r.uniform(0.6, 3.5), r.uniform(0, 2 * math.pi), r.uniform(0, 2 * math.pi)) for _ in range(9)]
    heights, biomes = [], bytearray()
    for row in range(size):
        for col in range(size):
            x = (col + 0.5) / size * 2 * extent - extent
            z = extent - (row + 0.5) / size * 2 * extent
            d = math.hypot(x, z)
            n = sum(math.sin(f * x / 1500 + a) * math.cos(f * z / 1500 + b) for f, a, b in waves) / len(waves)
            h = 1000 + 1700 * n + 500 * math.sin(d / 900 + n * 3)  # decimetres: water below 300
            h += 600 * math.exp(-(d / 1800) ** 2) - max(0, d - 9300) * 2.5  # dry land at spawn, the ocean at the edge
            ring = d + 1300 * n
            biome = (1 if ring < 1700 else 4 if ring < 3600 else 2 if (ring < 4400 and n < 0.15) else 4 if ring < 4400
                     else 5 if ring < 6200 else 10 if ring < 8300 else 3)
            if h > 1700 and d > 1500:
                biome = 3
            if z < -6800 and abs(x) < 6500:
                biome = 6
            if z > 7200 and abs(x) < 6000:
                biome = 7
            if d > 9800:
                biome = 9
            heights.append(max(-3000, min(3000, int(h))))
            biomes.append(biome)
    body = b"GSTR" + struct.pack("<iifi", 1, size, extent, seed) + struct.pack(f"<{size * size}h", *heights) + bytes(biomes)
    return gzip.compress(body)


def build(out, seed=7, target=350, end=None, gamedata=None):
    end = round(end or time.time())
    days = 40
    for _ in range(5):  # how many real days it takes these players to get the world to ~target in-game days
        sim = Sim(seed, end, days, 1.0)
        online = sim.run()
        if abs(sim.day() - target) <= 8:
            break
        days = max(7, round(days * target / max(sim.day(), 1)))
    print(f"demo: {days} days, {len(sim.ev):,} events, {len(sim.saves)} world saves, in-game day {sim.day()}, "
          f"{len(sim.zones):,} zones, {len(sim.boss_done)} bosses, {len(online)} online at the end", file=sys.stderr)

    tmp = tempfile.mkdtemp()
    try:
        data_dir, game = os.path.join(tmp, "data"), os.path.join(tmp, "game")
        sdir = os.path.join(data_dir, "demo")
        os.makedirs(sdir)
        os.makedirs(os.path.join(data_dir, "icons", "valheim"))
        with open(os.path.join(data_dir, "icons", "valheim", "creatures.json"), "w") as f:
            json.dump({s["boss"][0]: {"boss": True} for s in STAGES if s["boss"]}, f)
        os.makedirs(os.path.join(game, "worlds_local"))
        os.makedirs(os.path.join(game, "BepInEx", "gamestats"))
        with open(os.path.join(game, "BepInEx", "gamestats", "terrain-42.bin.gz"), "wb") as f:
            f.write(terrain())
        with open(os.path.join(game, "BepInEx", "gamestats", "terrain.json"), "w") as f:
            json.dump({"file": "terrain-42.bin.gz", "t": end}, f)
        server = {**SERVER, "world": {**SERVER["world"], "path": game}}
        names = {}
        clock = [0.0]
        quiet = contextlib.redirect_stdout(io.StringIO())
        with mock.patch.object(collector, "DATA_DIR", data_dir), \
                mock.patch.object(collector.time, "time", lambda: clock[0]), quiet:
            for t, world in sim.saves:
                wdir = os.path.join(game, "worlds_local")
                for n in os.listdir(wdir):
                    os.remove(os.path.join(wdir, n))
                files, more = world.files()
                names.update(more)
                for n, b in files.items():
                    with open(os.path.join(wdir, n), "wb") as f:
                        f.write(b)
                    os.utime(os.path.join(wdir, n), (t, t))
                with open(os.path.join(game, "manifest"), "w") as f:
                    f.write("\n".join(f"Assets/GameElements/{'Pieces/' if n in PIECE_NAMES else ''}{n}.prefab"
                                      for n in sorted(names.values())))
                # the collector re-reads the manifest when its time changes: the save's own, not whatever second this is
                os.utime(os.path.join(game, "manifest"), (t, t))
                clock[0] = t
                collector.world_update(server, CFG, sdir)
            collector.terrain_update(server, sdir)
            clock[0] = end
            with open(os.path.join(sdir, "equipment.json"), "w") as f:
                json.dump(sim.equipment(online), f)
            evs = sorted(sim.ev, key=lambda e: e["t"])
            collector.build(server, CFG, sdir, evs)
        if os.path.exists(out):
            shutil.rmtree(out)
        shutil.copytree(os.path.join(ROOT, "site"), out)
        site = os.path.join(data_dir, "site", "demo")
        for n in os.listdir(site):
            src = os.path.join(site, n)
            (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(out, n))
        if gamedata:
            shutil.copytree(gamedata, os.path.join(out, "icons", "valheim"))
    finally:
        shutil.rmtree(tmp)
    return sim


PIECE_NAMES = {name for stage in PIECES for name, _ in stage} | {"bed", "portal_wood", "sign", "piece_cartographytable"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out")
    ap.add_argument("--days", type=int, default=350, help="in-game days to reach (default 350)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--end", type=float, help="when the history ends, unix time (default: now)")
    ap.add_argument("--gamedata", help="the game's icons, items, creatures and looks (tools/), for OUT/icons/valheim")
    a = ap.parse_args()
    build(a.out, a.seed, a.days, a.end, a.gamedata)


if __name__ == "__main__":
    main()
