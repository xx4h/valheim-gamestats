"""Discord notifications for the gamestats collector.

After each rebuild, run() diffs the fresh data.json against what was already
announced (<server-id>/notify.json) and posts the news to a Discord webhook:
bosses slain, altars found, world milestones, raids, death sprees, new
players, first steps into a biome, peak-online records, round-number
milestones, leaderboard medal changes and award hand-overs, plus a weekly
recap on Sunday afternoon.

Medals and awards are all-time standings, mirroring the page's leaderboard
and titles card. A changed standing must hold for 10 minutes before
it is posted, so two players trading places for a moment stays quiet.

Nothing from history is ever posted: the first run, and any event kind added
later, only records what is already there.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from . import scoring

HOUR, DAY = 3600, 86400
RECENT = 45 * 60          # live events (raids, sprees) older than this are stale
SPREE_N, SPREE_S = 3, 600  # deaths within seconds that make a spree
DEBOUNCE = 10 * 60        # seconds a changed standing must hold before it's posted
RECAP_DAY, RECAP_HOUR = 6, 16  # Sunday 16:00, local time

KINDS = ("boss", "key", "altar", "biome", "player", "raid", "spree", "ms", "ph", "peak", "recap", "ach")

COLOR = {"boss": 0xE0A53B, "key": 0x199E70, "altar": 0x9085E9, "biome": 0x199E70, "player": 0x3987E5, "raid": 0xD95926,
         "spree": 0x6B6A65, "ms": 0xC98500, "ph": 0x3987E5, "peak": 0xD55181, "recap": 0xE0A53B, "medal": 0xC98500,
         "award": 0xD55181, "ach": 0x1B2838, "card": 0x9B59D0}

# Kept in step with site/app.js (RAIDS, BIOMES, MILESTONES, ALTAR).
RAIDS = {
    "army_eikthyr": "Eikthyr rallies the creatures of the forest", "army_theelder": "The forest is moving…",
    "army_bonemass": "A foul smell from the swamp", "army_moder": "A cold wind blows from the mountains",
    "army_goblin": "The horde is attacking", "army_gjall": "You hear a distant roar", "army_seekers": "They sought you out",
    "army_charred": "The dead march", "foresttrolls": "The ground is shaking", "skeletons": "Skeleton surprise",
    "blobs": "A foul smell from the swamp", "surtlings": "There's a smell of sulfur in the air",
    "wolves": "You are being hunted", "bats": "You stirred the cauldron",
}
BIOMES = [
    ("Meadows", "🌼", r"^(WoodHouse|WoodFarm|WoodVillage|Dolmen|Runestone_Meadows|Runestone_Boars|Eikthyrnir|StartTemple"
                     r"|StoneCircle|ShipSetting|Meteorite)"),
    ("Black Forest", "🌲", r"^(Crypt|StoneTowerRuins|StoneHouse|TrollCave|Greydwarf_camp|Runestone_Greydwarfs"
                          r"|Runestone_BlackForest|GDKing|Ruin\d|BearCave|Vendor_BlackForest|Grave|CombatRuin|BigRockClearing|Hildir_camp|MineCave)"),
    ("Swamp", "🦟", r"^(SunkenCrypt|SwampHut|InfestedTree|Runestone_Swamps|Runestone_Draugr|SwampRuin|SwampWell|FireHole|Bonemass"
                   r"|BogWitch)"),
    ("Mountains", "🏔️", r"^(DrakeNest|Waymarker|MountainCave|DrakeLorestone|MountainGrave|AbandonedLogCabin|MountainWell"
                        r"|Dragonqueen|Runestone_Mountains|Hildir_cave)"),
    ("Plains", "🌾", r"^(GoblinCamp|TarPit|StoneHenge|Goblinking|Runestone_Plains|Hildir_plainsfortress|PlainsFortress)"),
    ("Mistlands", "🌫️", r"^(Mistlands|Dvergr|TheQueen|Runestone_Mistlands|Giant)"),
    ("Ashlands", "🌋", r"^(Ashland|CharredFortress|FaderLocation|Runestone_Ashlands|MorgenHole|LeviathanLava|VoltureNest"
                      r"|PlaceofMystery)"),
]
AMBIGUOUS = re.compile(r"^(Dolmen|Grave|Ruin\d|CombatRuin|BigRockClearing)")
MILESTONES = {"killedtroll": "First troll slain", "killed_surtling": "First surtling slain", "killedbat": "First bat slain"}
SETTING_KEY = re.compile(r"^(activebosses|skillreductionrate|deathskillsreset|nobuildcost|playerdamage|enemydamage|enemyspeedsize"
                         r"|enemylevelupchance|resourcerate|staminarate|moveStaminarate|staminaregenrate|nomap|noportals|preset"
                         r"|worldlevel|eventrate|raidrate|passivemobs|playerevents|fire|nobossportals|dungeonbuild|teleportall"
                         r"|chaintimer|deathdeleteitems|deathdeleteunequipped|deathkeepequip)", re.I)
# Kept in step with site/app.js (RAID_TITLES, DUNGEON, TRADERS, … next to awardMetrics()).
RAID_TITLES = ("foresttrolls", "wolves", "surtlings", "skeletons", "bats")  # a "raid_<name>" title each
DUNGEON = re.compile(r"^(Crypt|SunkenCrypt|TrollCave|MountainCave|BearCave|Mistlands_DvergrTownEntrance|Hildir_crypt|Hildir_cave"
                     r"|Hildir_plainsfortress|MorgenHole|CharredFortress)")
TRADERS = [re.compile(r"^Vendor_BlackForest"), re.compile(r"^Hildir_camp"), re.compile(r"^BogWitch_Camp")]
STINKY = ("Entrails", "Guck", "Ooze", "Bloodbag")
DECOR = re.compile(r"^(piece_(chair|bench|logbench|table|throne|banner|cloth|rug|brazier|trap_troph|pot|maypole|jackoturnip|xmas"
                   r"|Christmas|\w*Garland)|rug_|itemstand|ArmorStand|piece_dvergr_lantern)")
FIRE = re.compile(r"^(fire_pit|bonfire|hearth|piece_groundtorch|piece_walltorch|piece_brazier|piece_Lavalantern"
                  r"|piece_dvergr_lantern|piece_jackoturnip)")
STRUCT = re.compile(r"^(wood|stone_|darkwood|blackmarble|iron_|ashwood|grausten|stake_wall|piece_dvergr_(wood|metal))")
WOODEN = re.compile(r"^(wood_|woodwall|stake_wall)")
RAGE, GHOST, FOLLOW, PACT, JONAH, RAID_WINDOW = 240, 300, 600, 60, 600, 300
ALTAR = {"Eikthyrnir": "Eikthyr", "GDKing": "The Elder", "Bonemass": "Bonemass", "Dragonqueen": "Moder",
         "GoblinKing": "Yagluth", "Mistlands_DvergrBossEntrance1": "The Queen", "FaderLocation": "Fader"}

# How much things count — titles, their minimums and texts, the medal columns, card yardsticks, milestone steps — is
# scoring.json (scoring.py; the server's overrides merged in), read from data["scoring"]. Here is only how things are
# measured and how a value reads.
SERVER_MS = {  # milestone -> (label, emoji); the steps are scoring "milestones"
    "hours": ("player-hours on the server", "⏳"), "zones": ("zones explored", "🧭"),
    "pieces": ("pieces standing in the world", "🏗️"), "deaths": ("deaths, and counting", "💀"),
}
# Leaderboard columns that can hand out medals: scoring "medals" key -> (stats() key, direction, formatter).
MEDALS = {
    "play": ("play", 1, lambda v: fh(v)), "sessions": ("sessions", 1, lambda v: f"{v}"),
    "longest": ("longest", 1, lambda v: fdur(v)), "nDays": ("ndays", 1, lambda v: f"{v}"),
    "deaths": ("deaths", -1, lambda v: f"{v}"), "built": ("built", 1, lambda v: f"{v:,}"),
    "found": ("found", 1, lambda v: f"{v:,}"),
}
# The titles posted when they change hands, and how their value reads; the metric (in stats() or extra_metrics()) is
# the title's key unless METRIC says otherwise. Titles of scoring.json that aren't here are on the page only (combat &
# gathering: the page computes those from the plugin's per-player breakdowns).
METRIC = {"marathon": "longest", "untouchable": "clean", "daredevil": "worst", "pathfinder": "found", "builder": "built"}
FMT = {
    "marathon": lambda v: fdur(v), "untouchable": lambda v: fdur(v), "streak": lambda v: f"{v} days", "bigday": lambda v: fh(v),
    "night": lambda v: fh(v), "morning": lambda v: fh(v), "company": lambda v: fh(v), "pathfinder": lambda v: f"{v:,} zones",
    "builder": lambda v: f"{v:,} pieces", "raids": lambda v: pl(v, "raid"), "daredevil": lambda v: pl(v, "death"),
    "blitz": lambda v: f"{v} zones in an hour", "speedbuild": lambda v: f"+{v:,} pieces in an hour",
    "badhour": lambda v: f"{v} deaths in an hour", "fastdeath": lambda v: f"dead {fdur(v)} after joining",
    "wreck": lambda v: f"−{v:,} pieces in an hour", "passenger": lambda v: f"pulls {v:.2f}× their weight",
    "wfh": lambda v: f"{fh(v)} on the clock", "lunch": lambda v: pl(v, "lunch break"), "lonewolf": lambda v: f"{fh(v)} alone",
    "inseparable": lambda v: f"{fh(v)} together", "ships": lambda v: f"together {fpct(v)} of the time",
    "lemming": lambda v: f"{v}× right behind", "firstlight": lambda v: f"first in on {v} days",
    "lightsout": lambda v: f"last out on {v} days", "revolving": lambda v: f"{v} logins in a day",
    "ghost": lambda v: f"{v} drive-by visits", "sunk": lambda v: f"{pl(v, 'session')} sunk",
    "immortal": lambda v: f"{fh(v)} · ≈ {pl(round(v / 1800), 'in-game day')}", "dejavu": lambda v: f"died twice in {fdur(v)}",
    "flyer": lambda v: f"a death every {fdur(v)}", "ragequit": lambda v: pl(v, "ragequit"),
    "pact": lambda v: f"{v}× off to Valhalla together", "jonah": lambda v: f"{pl(v, 'raid')} brought along",
    "survivor": lambda v: f"{v} raids survived", "casualty": lambda v: pl(v, "death"),
    **{f"raid_{n}": (lambda v: pl(v, "raid")) for n in RAID_TITLES},
    "edgelord": lambda v: f"{v / 1000:.2f} km out", "homebody": lambda v: f"Ø {v / 1000:.2f} km from spawn",
    "dungeon": lambda v: pl(v, "dungeon"), "contact": lambda v: f"found {pl(v, 'trader')}",
    "sealegs": lambda v: pl(v, "shipwreck"), "hoard": lambda v: f"{v:,} items", "rock": lambda v: f"{v:,} stone",
    "stinky": lambda v: f"{v:,} smelly things", "honey": lambda v: f"{v:,} honey", "tetris": lambda v: f"Ø {v:.1f} items a chest",
    "decorator": lambda v: f"{fpct(v)} decor", "woodage": lambda v: f"{fpct(v)} wood", "pyro": lambda v: pl(v, "fire"),
    "overachiever": lambda v: f"{v:,} × ★3+", "taxidermist": lambda v: f"{v:,} on display", "nomad": lambda v: f"{v} beds",
    "gordon": lambda v: pl(v, "sad meal"),
    # body & movement (server plugin Vitals.cs, from 1.14.0)
    "tank": lambda v: f"{v:,.0f} health", "lastbreath": lambda v: f"{v:,.1f} health left",
    "closecalls": lambda v: pl(v, "close call"),
    "sprinter": lambda v: f"{v:,.0f} m", "speeddemon": lambda v: f"{v * 3.6:,.1f} km/h",
    "mountaineer": lambda v: f"{v:,.0f} m above the sea", "skydiver": lambda v: f"{v:,.0f} m",
    "oneforteam": lambda v: f"{v:,.0f} damage", "globetrotter": lambda v: f"{v / 1000:,.1f} km",
    "fish": lambda v: f"{v / 1000:,.2f} km", "seadog": lambda v: f"{v / 1000:,.1f} km", "rider": lambda v: f"{v / 1000:,.2f} km",
    "empty": lambda v: pl(v, "time"), "sleepyhead": lambda v: pl(v, "night"), "showman": lambda v: pl(v, "emote"),
    "sneaky": lambda v: f"{v / 60:,.0f} min",
}
# Pair titles: the holder is "a\tb" (sorted, or follower\tleader); scoring.json's "pair" joins them for display.
PAIR = "\t"
# Read the current world save, not the time range: left out of the weekly recap.
BASE = {"tetris", "decorator", "woodage", "pyro", "overachiever", "taxidermist", "nomad", "gordon"}
PLACE = {1: "🥇", 2: "🥈", 3: "🥉"}
# Trading-card rarity (same as cardStats in site/app.js); a card keeps the best tier it ever reached.
TIERS = ["common", "rare", "epic", "legendary"]
# Bump when how a card stat is measured changes (its yardsticks are scoring "cards": a change there resets too): kept
# tiers are dropped (silently — a first sighting is never news).
CARD_SCALE = 2
# Bump when what a title measures changes (a change in scoring "titles" does the same): its kept holders are dropped
# and reseed silently, instead of announcing whoever leads the new measure as having taken it.
AWARD_DEFS = 3  # 2: hoard, rock, stinky, honey from pickups & loot, not chests they built; 3: Hildir's sealed tower is a dungeon
TIER_NAME = {"common": "★ Common", "rare": "★★ Rare", "epic": "★★★ Epic", "legendary": "★★★★ Legendary"}


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


# --------------------------------------------------------------------------
# formatting

def fh(sec):
    h = sec / HOUR
    return f"{h:.1f} h" if h < 10 else f"{round(h):,} h"


def fdur(sec):
    if sec < 60:
        return f"{round(sec)} s"
    m = round(sec / 60)
    if m < 60:
        return f"{m} min"
    return f"{m // 60}h {m % 60:02d}m" if m % 60 else f"{m // 60}h"


def pl(n, word):
    return f"{n:,} {word if n == 1 else word + 's'}"


def fpct(x):
    return f"{x * 100:.1f} %" if x < 0.1 else f"{x * 100:.0f} %"


def esc(s):
    """Player names are user input: no markdown, no mentions."""
    return re.sub(r"([\\*_~`|>\[\]()#-])", r"\\\1", s).replace("@", "@​")


def pretty(n):
    n = re.sub(r"^piece_", "", n).replace("_", " ")
    n = re.sub(r"([a-z])([A-Z0-9])", r"\1 \2", n)
    return re.sub(r"\s+", " ", n).strip().capitalize()


def ts(t, style="f"):
    return f"<t:{int(t)}:{style}>"  # rendered in each reader's own timezone


def and_list(xs):
    xs = list(xs)
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1] if xs else ""


# --------------------------------------------------------------------------
# metrics (same definitions as the page)

class Ctx:
    def __init__(self, data, url):
        self.d, self.url = data, (url or "").rstrip("/")
        self.now = data["generated"]
        self.tz = ZoneInfo(data.get("tz") or "UTC")
        self.rules = data["scoring"]["rules"]
        self.ses = [(s["p"], s["s"], s["e"] if s["e"] is not None else self.now) for s in data["sessions"]]
        self.deaths = defaultdict(list)
        for x in data["deaths"]:
            self.deaths[x["p"]].append(x["t"])

    def who(self, p):
        return f"[{esc(p)}]({self.url}/#/p/{urllib.parse.quote(p)})" if self.url else f"**{esc(p)}**"

    def link(self, frag=""):
        return f"{self.url}/{frag}" if self.url else None

    def online_during(self, a, b):
        return sorted({p for p, s, e in self.ses if s < b and e > a})


def each_hour(s, e):
    h = int(s // HOUR) * HOUR
    while h < e:
        x, y = max(s, h), min(e, h + HOUR)
        if y > x:
            yield h, y - x
        h += HOUR


def stats(c, a, b, built=None):
    """Per-player numbers for [a, b). built: {player: pieces} (standing, or added in range)."""
    P = defaultdict(lambda: {"play": 0, "sessions": 0, "longest": 0, "days": Counter(), "deaths": 0, "night": 0,
                             "morning": 0, "company": 0, "found": 0, "raids": 0, "clean": 0, "worst": 0,
                             "wfh": 0, "lonewolf": 0})
    clipped = []
    for p, s, e in c.ses:
        x, y = max(s, a), min(e, b)
        if y <= x:
            continue
        clipped.append((p, x, y))
        r = P[p]
        r["play"] += y - x
        r["sessions"] += 1
        r["longest"] = max(r["longest"], y - x)
        for h, sec in each_hour(x, y):
            local = datetime.fromtimestamp(h, c.tz)
            r["days"][local.date()] += sec
            if local.hour < 5:
                r["night"] += sec
            elif local.hour < 9:
                r["morning"] += sec
            if local.weekday() < 5 and 9 <= local.hour < 17:
                r["wfh"] += sec
        n = sum(1 for t in c.deaths[p] if x <= t <= y)
        r["worst"] = max(r["worst"], n)
        if not n:
            r["clean"] = max(r["clean"], y - x)
        # first death of the session, counted from when they actually joined
        first = min((t for t in c.deaths[p] if x <= t <= y), default=None)
        if first is not None and (r.get("fastdeath") is None or first - s < r["fastdeath"]):
            r["fastdeath"] = first - s
    for p, ts_ in c.deaths.items():
        n = sum(1 for t in ts_ if a <= t < b)
        if n:
            P[p]["deaths"] += n
    for z in c.d["zones"]:
        if a <= z["t"] < b:
            for p in z["by"]:
                P[p]["found"] += 1
    for r in c.d["raids"]:
        if a <= r["t"] < b:
            for p in r["players"]:
                P[p]["raids"] += 1
    # "x within an hour": best sliding one-hour window
    ztimes = defaultdict(list)
    for z in c.d["zones"]:
        if a <= z["t"] < b:
            for p in z["by"]:
                ztimes[p].append(z["t"])
    for p, times in ztimes.items():
        P[p]["blitz"] = best_hour(times)
    for p, times in c.deaths.items():
        n = best_hour([t for t in times if a <= t < b])
        if n:
            P[p]["badhour"] = n
    # pieces added / torn down between two consecutive hourly world saves
    hist = c.d.get("world_history") or []
    for h0, h1 in zip(hist, hist[1:], strict=False):
        # both snapshots from the same (crop-free, v4+) reader: a counting change is not building or demolishing
        if not a <= h1["t"] < b or h1["t"] - h0["t"] > 1.5 * HOUR or not h0.get("v") or h0.get("v") != h1.get("v"):
            continue
        for p in set(h0["pieces"]) | set(h1["pieces"]):
            d = h1["pieces"].get(p, 0) - h0["pieces"].get(p, 0)
            if d > P[p].get("speedbuild", 0):
                P[p]["speedbuild"] = d
            if -d > P[p].get("wreck", 0):
                P[p]["wreck"] = -d
    # time with at least one other player online: sweep over session edges
    ev = sorted([(x, 1, p) for p, x, y in clipped] + [(y, -1, p) for p, x, y in clipped])
    active, last, peak = Counter(), None, (0, None)
    for t, k, p in ev:
        if last is not None and t > last:
            online = [q for q, n in active.items() if n > 0]
            if len(online) >= 2:
                for q in online:
                    P[q]["company"] += t - last
            elif len(online) == 1:
                P[online[0]]["lonewolf"] += t - last
        active[p] += k
        n = sum(1 for v in active.values() if v > 0)
        if n > peak[0]:
            peak = (n, t)
        last = t
    for p, r in P.items():
        r["ndays"] = sum(1 for v in r["days"].values() if v > 0)
        r["bigday"] = max(r["days"].values(), default=0)
        best = cur = 0
        prev = None
        for d in sorted(r["days"]):
            cur = cur + 1 if prev and d - prev == timedelta(days=1) else 1
            best, prev = max(best, cur), d
        r["streak"] = best
        r["built"] = (built or {}).get(p, 0)
    for p, v in (built or {}).items():
        if p not in P and v > 0:
            P[p]["built"] = v
    return dict(P), peak


def medal_table(P, rules):
    """{column: [[place, [names]], ...]} for places 1-3, ties sharing a place, for the medal columns in the rules."""
    out = {}
    for col in rules["medals"]:
        key, direction, _ = MEDALS[col]
        rows = [(p, r[key]) for p, r in P.items() if (r["play"] >= HOUR if direction < 0 else r[key] > 0)]
        rows.sort(key=lambda x: (-direction * x[1], x[0]))
        places, prev, place = [], None, 0
        for i, (p, v) in enumerate(rows):
            if v != prev:
                place, prev = i + 1, v
            if place > 3:
                break
            if places and places[-1][0] == place:
                places[-1][1].append(p)
            else:
                places.append([place, [p]])
        out[col] = places
    return out


def best_hour(times):
    times, j, best = sorted(times), 0, 0
    for i, t in enumerate(times):
        while t - times[j] >= HOUR:
            j += 1
        best = max(best, i - j + 1)
    return best


def passenger(P):
    """Share of exploration + building over share of playtime, for players with ≥2 h (1 = pulls their weight)."""
    crew = [p for p, r in P.items() if r.get("play", 0) >= 2 * HOUR]
    if len(crew) < 2:
        return {}
    tot = lambda k: sum(P[p].get(k, 0) for p in crew)
    T, F, B = tot("play"), tot("found"), tot("built")
    out = {}
    for p in crew:
        parts = ([P[p].get("found", 0) / F] if F else []) + ([P[p].get("built", 0) / B] if B else [])
        if parts:
            out[p] = round(sum(parts) / len(parts) / (P[p]["play"] / T), 4)  # rounded: steady across runs
    return out


def extra_metrics(c, a, b, P, world=None):
    """The awards stats() doesn't cover: login habits, pairs, raids, exploration and, given a
    world snapshot, the base. {metric: {holder: value}}; P supplies playtime and deaths in [a, b)."""
    d, X = c.d, defaultdict(dict)

    def add(k, h, v=1):
        X[k][h] = X[k].get(h, 0) + v

    def hi(k, h, v):
        if v > X[k].get(h, float("-inf")):
            X[k][h] = v

    def lo(k, h, v):
        if v < X[k].get(h, float("inf")):
            X[k][h] = v

    pair = lambda x, y: f"{x}{PAIR}{y}" if x < y else f"{y}{PAIR}{x}"
    end = lambda s: s["e"] if s["e"] is not None else c.now
    ses = d["sessions"]
    by_ses = defaultdict(list)
    for s in ses:
        by_ses[s["p"]].append(s)
    deaths = {p: sorted(ts) for p, ts in c.deaths.items()}
    online = lambda p, x, y: sum(max(0, min(y, end(s)) - max(x, s["s"])) for s in by_ses[p])
    play = {p: r["play"] for p, r in P.items() if r.get("play")}

    # ---- logins (sessions that started in range)
    per_day, days = Counter(), defaultdict(list)
    for s in ses:
        if not a <= s["s"] < b or end(s) <= s["s"]:
            continue
        local = datetime.fromtimestamp(s["s"], c.tz)
        per_day[(s["p"], local.date())] += 1
        days[local.date()].append(s)
        if local.weekday() < 5 and local.hour in (12, 13):
            add("lunch", s["p"])
        if s["e"] is not None and s["e"] - s["s"] < GHOST:
            add("ghost", s["p"])
        for q in {o["p"] for o in ses if o["p"] != s["p"] and o["s"] < s["s"] and s["s"] - o["s"] <= FOLLOW}:
            add("lemming", f"{s['p']}{PAIR}{q}")
    for (p, _), n in per_day.items():
        hi("revolving", p, n)
    for day in days.values():
        if len({s["p"] for s in day}) < 2:
            continue
        add("firstlight", min(day, key=lambda s: s["s"])["p"])
        if all(s["e"] is not None for s in day):
            add("lightsout", max(day, key=lambda s: s["e"])["p"])
    for s in ses:
        e = s["e"]
        if e is None or not a <= e < b or e <= s["s"]:
            continue
        if s["end"] == "restart":
            add("sunk", s["p"])
        if s["end"] == "logout" and any(s["s"] <= t <= e and e - t <= RAGE for t in deaths.get(s["p"], ())):
            add("ragequit", s["p"])

    # ---- pairs
    clipped = sorted((max(s, a), min(e, b), p) for p, s, e in c.ses if min(e, b) > max(s, a))
    for i, (_x0, x1, xp) in enumerate(clipped):
        for y0, y1, yp in clipped[i + 1:]:
            if y0 >= x1:
                break
            if xp != yp:
                add("inseparable", pair(xp, yp), min(x1, y1) - y0)
    regulars = sorted(p for p, v in play.items() if v >= 3 * HOUR)
    if len(regulars) >= 3:
        for i, x in enumerate(regulars):
            for y in regulars[i + 1:]:
                X["ships"][pair(x, y)] = round(X["inseparable"].get(pair(x, y), 0) / min(play[x], play[y]), 4)
    ds = sorted((t, p) for p, ts in deaths.items() for t in ts if a <= t < b)
    for i, (t, p) in enumerate(ds):
        for t2, p2 in ds[i + 1:]:
            if t2 - t > PACT:
                break
            if p2 != p:
                add("pact", pair(p, p2))

    # ---- death & danger
    for p, ts in deaths.items():
        inr = [t for t in ts if a <= t < b]
        for t0, t1 in zip(inr, inr[1:], strict=False):
            if t1 > t0:
                lo("dejavu", p, t1 - t0)
        if play.get(p, 0) >= 5 * HOUR and inr:
            X["flyer"][p] = play[p] / len(inr)
        for t in inr:
            if any(r["t"] <= t < r["t"] + RAID_WINDOW for r in d["raids"]):
                add("casualty", p)
    for p in play:
        ends = deaths.get(p, []) + [min(b, c.now)]
        for i, e in enumerate(ends):
            if a <= e <= b:
                hi("immortal", p, online(p, ends[i - 1] if i else float("-inf"), e))
    for r in d["raids"]:
        if not a <= r["t"] < b:
            continue
        for p in r["players"]:
            if r["n"] in RAID_TITLES:
                add(f"raid_{r['n']}", p)
            if any(s["s"] <= r["t"] and r["t"] - s["s"] <= JONAH for s in by_ses[p]):
                add("jonah", p)
            if not any(r["t"] <= t < r["t"] + RAID_WINDOW for t in deaths.get(p, ())):
                add("survivor", p)

    # ---- exploration
    spawn = next((z for z in d["zones"] if any(loc.startswith("StartTemple") for loc in z["l"])), {"x": 0, "y": 0})
    dist = lambda z: ((z["x"] - spawn["x"]) ** 2 + (z["y"] - spawn["y"]) ** 2) ** 0.5 * 64
    found, far = Counter(), Counter()
    for z in d["zones"]:
        if not a <= z["t"] < b:
            continue
        for p in z["by"]:
            found[p] += 1
            far[p] += dist(z)
            hi("edgelord", p, dist(z))
            if any(DUNGEON.match(loc) for loc in z["l"]):
                add("dungeon", p)
            if any(loc.startswith("ShipWreck") for loc in z["l"]):
                add("sealegs", p)
    for p, n in found.items():
        if n >= 10 and play.get(p, 0) >= 2 * HOUR:
            X["homebody"][p] = round(far[p] / n, 1)
    for rx in TRADERS:
        z = next((z for z in d["zones"] if any(rx.match(loc) for loc in z["l"])), None)  # zones are in discovery order
        if z and a <= z["t"] < b:
            for p in z["by"]:
                add("contact", p)

    # ---- hoarding: first pickups and world-chest loot from the server plugin, in range
    for t, p, e, i, n in d.get("gather") or []:
        if not a <= t < b:
            continue
        if e == "loot":
            add("hoard", p, n)
        elif e == "pick":
            if i == "Stone":
                add("rock", p, n)
            if i == "Honey":
                add("honey", p, n)
            if i in STINKY:
                add("stinky", p, n)

    # ---- body & movement: the plugin's sums (gather), hourly maxima (peaks) and single feats, in range
    DIST = {"swim": "fish", "boat": "seadog", "ride": "rider"}
    SUMS = {"exhn": "empty", "bed": "sleepyhead", "emote": "showman", "crouch": "sneaky"}
    for t, p, e, i, n in d.get("gather") or []:
        if not a <= t < b:
            continue
        if e == "dist":
            add("globetrotter", p, n)
            if i in DIST:
                add(DIST[i], p, n)
        elif e in SUMS:
            add(SUMS[e], p, n)
    PEAK = {"hp": "tank", "y": "mountaineer", "v_foot": "speeddemon", "hit": "oneforteam"}
    for t, p, k, v in d.get("peaks") or []:
        if a <= t < b and k in PEAK:
            hi(PEAK[k], p, v)
    for t, p, kind, v, _ in d.get("feats") or []:
        if not a <= t < b or v is None:
            continue
        if kind == "sprint":
            hi("sprinter", p, v)
        elif kind == "fall":
            hi("skydiver", p, v)
        elif kind == "closecall":
            add("closecalls", p)
            lo("lastbreath", p, v)

    # ---- the base as it stands
    if world:
        for name, it in (world.get("items") or {}).items():
            for p, n in (it.get("shown") or {}).items():
                add("taxidermist", p, n)
            for p, q in (it.get("q") or {}).items():
                for lvl, n in q.items():
                    if int(lvl) >= 3:
                        add("overachiever", p, n)
            if "sapling" in name.lower():  # crops grow into objects without a creator
                continue
            for p, n in (it.get("built") or {}).items():
                add("_pieces", p, n)
                if DECOR.match(name):
                    add("_decor", p, n)
                if FIRE.match(name):
                    add("pyro", p, n)
                if STRUCT.match(name):
                    add("_struct", p, n)
                    if WOODEN.match(name):
                        add("_wood", p, n)
        for p, n in X["_pieces"].items():
            if n >= 30:
                X["decorator"][p] = round(X["_decor"].get(p, 0) / n, 4)
        if "defeated_gdking" in world.get("keys", ()):
            for p, n in X["_struct"].items():
                if n >= 50:
                    X["woodage"][p] = round(X["_wood"].get(p, 0) / n, 4)
        for p, n in (world.get("chests") or {}).items():
            if n >= 3:
                X["tetris"][p] = round((world.get("chest_items") or {}).get(p, 0) / n, 4)
        X["nomad"].update(world.get("beds") or {})
        for p, k in (world.get("kitchen") or {}).items():
            X["gordon"][p] = k.get("burnt", 0) + k.get("done", 0)
    return X


def award_table(P, rules, X=None, skip=()):
    """{title: [sorted holders, value]} for the titles in the rules someone qualifies for (highest value wins, lowest for a
    "low" one; ties share). X: extra_metrics()."""
    pas = passenger(P)
    X = X or {}
    out = {}
    for key, t in rules["titles"].items():
        if key in skip or key not in FMT:
            continue
        metric, low, minimum = METRIC.get(key, key), t.get("low", False), t.get("min", 0)
        if metric == "passenger":
            vals = pas
        elif metric in X:
            vals = {h: v for h, v in X.get(metric, {}).items() if v is not None and (low or v >= minimum)}
        elif low:
            vals = {p: r[metric] for p, r in P.items() if r.get(metric) is not None}
        else:
            vals = {p: r.get(metric, 0) for p, r in P.items() if r.get(metric, 0) >= minimum}
        if vals:
            top = (min if low else max)(vals.values())
            out[key] = [sorted(p for p, v in vals.items() if v == top), top]
    return out


def title_rule(c, t):
    return t["rule"].replace("{tz}", str(c.tz))


def built_between(hist, a, b):
    """Net pieces per player between the snapshot in force at a and the last one before b."""
    before = [h for h in hist if h["t"] < a]
    inside = [h for h in hist if a <= h["t"] < b]
    frm = before[-1] if before else (inside[0] if inside else None)
    to = ([h for h in hist if h["t"] < b] or [None])[-1]
    if not frm or not to or to["t"] <= frm["t"]:
        return None
    names = set(frm["pieces"]) | set(to["pieces"])
    return {p: to["pieces"].get(p, 0) - frm["pieces"].get(p, 0) for p in names}


def biome_of(z):
    fallback = None
    for loc in z["l"]:
        for name, emoji, rx in BIOMES:
            if re.match(rx, loc):
                if not AMBIGUOUS.match(loc):
                    return name, emoji
                fallback = fallback or (name, emoji)
                break
    return fallback


# --------------------------------------------------------------------------
# events: (id, kind, t, embed)

def embed(c, kind, title, desc="", t=None, url=None, fields=None):
    e = {"title": title, "description": desc.strip(), "color": COLOR[kind], "footer": {"text": c.d["title"]}}
    if t:
        e["timestamp"] = datetime.fromtimestamp(t, UTC).isoformat()
    if url or c.url:
        e["url"] = url or c.link()
    if fields:
        e["fields"] = fields
    return e


def events(c):
    d, w, out = c.d, c.d.get("world"), []
    hist = d.get("world_history") or []
    live_times = d.get("key_times") or {}  # rcon.py: the poll window a key appeared in

    def key_window(k):
        if k in live_times:
            return tuple(live_times[k])
        i = next((i for i, h in enumerate(hist) if k in h["keys"]), None)
        return (hist[i - 1]["t"], hist[i]["t"]) if i else (None, None)

    if w:
        bosses = {k: n for k, n, _ in w["bosses"]}
        for k in w["keys"]:
            if SETTING_KEY.match(k):
                continue
            a, b = key_window(k)
            when = f"Between {ts(a)} and {ts(b, 't')}" if a else ""
            crew = c.online_during(a, b) if a else []
            crew_txt = f"\nOnline at the time: {and_list(map(c.who, crew))}" if crew else ""
            if k.startswith("defeated_"):
                name = bosses.get(k) or pretty(k[9:])
                out.append((f"boss:{k}", "boss", b, embed(c, "boss", f"⚔️ {name} has fallen!",
                            f"The server has defeated **{name}**. Skål! 🍻\n{when}{crew_txt}", b, c.link("#/base"))))
            else:
                name = MILESTONES.get(k) or pretty(k)
                out.append((f"key:{k}", "key", b, embed(c, "key", f"✔️ {name}", f"{when}{crew_txt}".strip(), b)))
        for loc in w.get("boss_altars") or {}:
            boss = ALTAR.get(loc, pretty(loc))
            out.append((f"altar:{loc}", "altar", None, embed(c, "altar", f"🗺️ The altar of {boss} has been found",
                        f"Someone stumbled upon **{boss}**'s altar. Time to prepare…", None, c.link("#/base"))))

    seen_biome = set()
    for z in d["zones"]:
        bi = biome_of(z)
        if not bi or bi[0] in seen_biome:
            continue
        seen_biome.add(bi[0])
        by = f" by {and_list(map(c.who, z['by']))}" if z["by"] else ""
        out.append((f"biome:{bi[0]}", "biome", z["t"], embed(c, "biome", f"{bi[1]} First steps into the {bi[0]}",
                    f"Discovered{by} {ts(z['t'], 'R')}.", z["t"], c.link("#/world"))))

    first = {}
    for p, s, _e in c.ses:
        first[p] = min(first.get(p, s), s)
    for p, s in first.items():
        if c.now - s < DAY:
            out.append((f"player:{p}", "player", s, embed(c, "player", "👋 A new Viking arrives!",
                        f"Welcome {c.who(p)} to **{esc(d['title'])}**! First seen {ts(s, 'R')}.", s)))

    for r in d["raids"]:
        if c.now - r["t"] < RECENT:
            who = (f"Defenders online: {and_list(map(c.who, r['players']))}" if r["players"]
                   else "Nobody online — the base is on its own!")
            out.append((f"raid:{r['t']}", "raid", r["t"], embed(c, "raid", f"🛡️ Raid! {RAIDS.get(r['n'], pretty(r['n']))}",
                        f"{who}\nStarted {ts(r['t'], 'R')}.", r["t"], c.link("#/raids"))))

    for p, times in c.deaths.items():
        times = sorted(times)
        i = 0
        while i < len(times):
            j = i
            while j + 1 < len(times) and times[j + 1] - times[i] <= SPREE_S:
                j += 1
            if j - i + 1 >= SPREE_N:
                if c.now - times[j] < RECENT:
                    n = j - i + 1
                    out.append((f"spree:{p}:{times[i]}", "spree", times[j], embed(c, "spree", "💀 Rough moment",
                                f"{c.who(p)} died **{n} times** in {fdur(max(60, times[j] - times[i]))}. "
                                "Somebody bring them a mead.",
                                times[j], c.link("#/deaths"))))
                i = j + 1
            else:
                i += 1

    P_all, peak = stats(c, 0, c.now + 1)
    ms = c.rules["milestones"]
    for p, r in P_all.items():
        hit = [h for h in ms["player_hours"] if r["play"] >= h * HOUR]
        if hit:
            h = hit[-1]
            out.append((f"ph:{p}:{h}", "ph", None, embed(c, "ph", f"⏳ {h} hours in Valheim",
                        f"{c.who(p)} has now spent **{h} hours** on the server.", None)))
    totals = {
        "hours": sum(r["play"] for r in P_all.values()) / HOUR,
        "zones": len(d["zones"]),
        "pieces": sum(v["total"] for v in (w or {}).get("pieces", {}).values()),
        "deaths": len(d["deaths"]),
    }
    for m, (label, emoji) in SERVER_MS.items():
        hit = [s for s in ms[m] if totals[m] >= s]
        if hit:
            s = hit[-1]
            out.append((f"ms:{m}:{s}", "ms", None,
                        embed(c, "ms", f"{emoji} {s:,} {label}", f"The server just passed **{s:,}** {label}.", None)))
    if ms["day_every"] and (d.get("day") or 0) >= ms["day_every"]:
        s = d["day"] // ms["day_every"] * ms["day_every"]
        out.append((f"ms:day:{s}", "ms", None, embed(c, "ms", f"☀️ Day {s:,}", f"The world has seen **{s:,}** days.", None)))
    if peak[0] >= 3:
        out.append((f"peak:{peak[0]}", "peak", peak[1], embed(c, "peak", f"🎉 {peak[0]} Vikings online at once!",
                    f"New record for players online at the same time, {ts(peak[1], 'R')}.", peak[1])))

    out.extend(achievements(c))
    out.extend(recap(c, hist))
    return out, P_all


def achievements(c):
    """Steam achievement unlocks of the last two days: a profile turning public must not dump its history."""
    st = c.d.get("steam") or {}
    by = {a["k"]: a for a in st.get("achievements", [])}
    out = []
    for main, pl in (st.get("players") or {}).items():
        for k, t in pl.get("unlocked", {}).items():
            a = by.get(k)
            if not a or c.now - t > 2 * DAY:
                continue
            here = any(p in pl["chars"] and s - 120 <= t <= e + 120 for p, s, e in c.ses)
            bits = [f"*{a['d']}*" if a.get("d") else None,
                    f"Only **{a['pct']:.1f} %** of all Valheim players have it." if a.get("pct") is not None and a["pct"] < 10
                    else f"{a['pct']:.0f} % of all Valheim players have it." if a.get("pct") is not None else None,
                    f"Earned on **{esc(c.d['title'])}** {ts(t, 'R')}." if here else f"Earned elsewhere {ts(t, 'R')}."]
            e = embed(c, "ach", f"🏆 {main} unlocked “{a['n']}”", "\n".join(b for b in bits if b), t, c.link("#/achievements"))
            if c.url and a.get("icon"):
                e["thumbnail"] = {"url": f"{c.url}/steam/{st['app']}/{a['icon']}"}
            out.append((f"ach:{main}:{k}", "ach", t, e))
    return out


def recap(c, hist):
    """Weekly recap of the 7 days up to Sunday RECAP_HOUR local time, posted from then on.
    Sunday-to-Sunday, so consecutive recaps leave no gap."""
    now = datetime.fromtimestamp(c.now, c.tz)
    due = (now - timedelta(days=(now.weekday() - RECAP_DAY) % 7)).replace(hour=RECAP_HOUR, minute=0, second=0, microsecond=0)
    if now < due:
        due -= timedelta(days=7)  # today's recap isn't due yet: the last one stays current
    # aware datetimes subtract in wall-clock time, so both ends stay at 16:00 across DST
    a, b = (due - timedelta(days=7)).timestamp(), due.timestamp()
    wk = due.isocalendar()
    rid = f"recap:{wk[0]}-W{wk[1]:02d}"
    net = built_between(hist, a, b)
    P, peak = stats(c, a, b, {p: v for p, v in (net or {}).items() if v > 0})
    if not any(r["play"] for r in P.values()):
        return []
    d = c.d
    hours = sum(r["play"] for r in P.values())
    top = sorted(P.items(), key=lambda x: -x[1]["play"])[:3]
    day_at = lambda t: next((x["d"] for x in reversed(d["days"]) if x["t"] < t), None)
    days = day_at(b) - day_at(a) if day_at(a) is not None and day_at(b) is not None else None
    lines = [
        f"⏳ **{fh(hours)}** played by **{sum(1 for r in P.values() if r['play'])}** Vikings "
        f"in **{sum(r['sessions'] for r in P.values())}** sessions",
        f"💀 **{sum(1 for x in d['deaths'] if a <= x['t'] < b)}** deaths"
        f" · ⚔️ **{sum(1 for x in d['raids'] if a <= x['t'] < b)}** raids"
        f" · 🧭 **{sum(1 for z in d['zones'] if a <= z['t'] < b):,}** new zones",
    ]
    if net is not None or days is not None:
        bits = (([f"🏗️ **{sum(net.values()):+,}** pieces"] if net is not None else []) +
                ([f"☀️ **{days}** in-game days"] if days else []))
        lines.append(" · ".join(bits))
    if peak[0] >= 2:
        lines.append(f"🎉 Peak: **{peak[0]}** online at once")
    fields = [{"name": "Most played", "value": "\n".join(f"{PLACE[i + 1]} {c.who(p)} · {fh(r['play'])}"
                                                         for i, (p, r) in enumerate(top)), "inline": False}]
    aw = award_table(P, c.rules, extra_metrics(c, a, b, P), skip=BASE)
    title = f"📜 Week {wk[1]} recap — {datetime.fromtimestamp(a, c.tz):%-d %b} – {due:%-d %b}"
    # Discord: ≤1024 chars per field value, ≤6000 per embed — split by group, drop what doesn't fit.
    budget = 5800 - len(title) - len(c.d["title"]) - sum(len(x) for x in lines) - len(fields[0]["value"])
    dropped = 0
    for g, label in c.rules["title_groups"].items():
        name, chunk = f"Titles of the week · {label}", []
        for k, t in c.rules["titles"].items():
            if k not in aw or t["group"] != g:
                continue
            line = f"{t['icon']} **{t['title']}** — {holders(c, k, aw[k][0])} · {FMT[k](aw[k][1])}"
            if len(line) > 1024 or budget - len(line) - len(name) < 0:
                dropped += 1
                continue
            if sum(len(x) + 1 for x in chunk) + len(line) > 1024:
                fields.append({"name": name, "value": "\n".join(chunk), "inline": False})
                budget -= len(name)
                name, chunk = f"{label} (cont.)", []
            chunk.append(line)
            budget -= len(line) + 1
        if chunk:
            fields.append({"name": name, "value": "\n".join(chunk), "inline": False})
            budget -= len(name)
    if dropped:
        lines.append(f"…and {dropped} more titles on the page")
    return [(rid, "recap", None, embed(c, "recap", title, "\n".join(lines), None, None, fields[:25]))]


# --------------------------------------------------------------------------
# standings: medals + awards, debounced

def standings(c, P_all, world):
    built = {p: v["total"] for p, v in ((world or {}).get("pieces") or {}).items()}
    for p, r in P_all.items():
        r["built"] = built.get(p, 0)
    for p, v in built.items():  # builders who never showed up in the log window still count
        P_all.setdefault(p, {k: 0 for k in ("play", "sessions", "longest", "ndays", "deaths", "found", "clean", "worst",
                                            "streak", "bigday", "night", "morning", "company", "raids")})["built"] = v
    out = {f"medal:{k}": v for k, v in medal_table(P_all, c.rules).items()}
    out.update({f"award:{k}": v for k, v in award_table(P_all, c.rules, extra_metrics(c, 0, c.now + 1, P_all, world)).items()})
    return out, P_all


def card_tiers(c, P, world):
    """{player: (tier, stats)}: all-time stats 0–99 on fixed yardsticks (scoring "cards"), rarity from their average.

    Combat (damage dealt) and gathering (items picked up) only where the server
    plugin logs them (data.json "gather") — else everyone's 0 would drag every
    card down. Same as cardStats() in site/app.js."""
    X = extra_metrics(c, 0, c.now + 1, P, world)
    built = {p: v["total"] for p, v in ((world or {}).get("pieces") or {}).items()}
    rows = {p: {"survived": X.get("survivor", {}).get(p, 0), "built": built.get(p, 0), "zones": r.get("found", 0),
                "dph": r.get("deaths", 0) / (r["play"] / HOUR) if r["play"] >= HOUR else None}
            for p, r in P.items() if r.get("play", 0) > 0}
    gather = c.d.get("gather") or []
    for p, row in rows.items():
        row["dealt"] = sum(g[4] for g in gather if g[1] == p and g[2] == "dmg")
        row["picked"] = sum(g[4] for g in gather if g[1] == p and g[2] == "pick")

    cr = c.rules["cards"]

    def scale(p, k, low=False):
        v = rows[p][k]
        if v is None:
            return 0
        x = 1 / (1 + v / cr["dph"]) if low else min(1.0, (v / cr["at"][k]) ** 0.5)
        return int(99 * x + 0.5)

    out = {}
    for p in rows:
        st = {"raids": scale(p, "survived"), "survival": scale(p, "dph", True), "building": scale(p, "built"),
              "exploring": scale(p, "zones")}
        if gather:
            st.update(combat=scale(p, "dealt"), gathering=scale(p, "picked"))
        avg = sum(st.values()) / len(st)
        out[p] = (next((t for t in TIERS[:0:-1] if avg >= cr["tiers"][t]), "common"), st)
    return out


def card_embed(c, p, tier, st):
    return embed(c, "card", f"🃏 {p}'s trading card evolved to {TIER_NAME[tier]}!",
                 f"⚔ Raids **{st['raids']}** · 🛡 Survival **{st['survival']}** · 🔨 Building **{st['building']}** · "
                 f"🧭 Exploring **{st['exploring']}**"
                 + (f" · 🗡 Combat **{st['combat']}** · 🎒 Gathering **{st['gathering']}**" if "combat" in st else ""),
                 None, c.link(f"#/p/{urllib.parse.quote(p)}"))


def medal_embed(c, changes, P):
    lines = []
    for key, old, new in changes:
        col = key.split(":", 1)[1]
        stat, _, fmt = MEDALS[col]
        oldp = {p: pl for pl, ps in (old or []) for p in ps}
        moves = []
        for pl, ps in new:
            for p in ps:
                if p not in oldp:
                    moves.append(f"{c.who(p)} takes {PLACE[pl]}")
                elif pl < oldp[p]:
                    moves.append(f"{c.who(p)} climbs to {PLACE[pl]}")
        if not moves:
            continue
        podium = " · ".join(f"{PLACE[pl]} {', '.join(esc(p) for p in ps)} ({fmt(P[ps[0]][stat])})" for pl, ps in new)
        lines.append(f"**{c.rules['medals'][col]['label']}**: {and_list(moves)}\n{podium}")
    if not lines:
        return None
    return embed(c, "medal", "🏆 Leaderboard shake-up", "\n\n".join(lines), None, c.link("#/"))


def holders(c, key, hs):
    """Title holders as links; a pair title's holder is two players."""
    return and_list(c.rules["titles"][key].get("pair", " & ").join(c.who(p) for p in h.split(PAIR)) for h in hs)


def award_embed(c, key, old, new):
    k = key.split(":", 1)[1]
    t, fmt = c.rules["titles"][k], FMT[k]
    who = holders(c, k, new[0])
    one = len(new[0]) == 1 and PAIR not in new[0][0]
    if old and set(old[0]) & set(new[0]):
        desc = f"{who} now share{'s' if one else ''} the title · {fmt(new[1])}"
    elif old:
        desc = f"{who} {'takes' if one else 'take'} the title from {holders(c, k, old[0])} · {fmt(new[1])}"
    else:
        desc = f"First title holder: {who} · {fmt(new[1])}"
    return embed(c, "award", f"{t['icon']} {t['title']} title", f"*{title_rule(c, t)}*\n{desc}", None, c.link("#/"))


# --------------------------------------------------------------------------

def post(webhook, username, embeds):
    body = json.dumps({"username": username, "embeds": embeds, "allowed_mentions": {"parse": []}}).encode()
    req = urllib.request.Request(webhook + ("&" if "?" in webhook else "?") + "wait=true", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "valheim-gamestats"})
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def run(server, sdir, data, dry=False):
    ncfg = server["notify"]
    webhook = os.environ.get(ncfg.get("webhook_env", ""), "")
    if not webhook and not dry:
        log(f"[{server['id']}] notify: no webhook in ${ncfg.get('webhook_env')}, skipping")
        return
    path = os.path.join(sdir, "notify.json")
    state = {}
    if os.path.exists(path):
        with open(path) as f:
            state = json.load(f)
    state.setdefault("kinds", [])
    state.setdefault("seen", {})
    state.setdefault("standings", {})
    state.setdefault("pending", {})
    c = Ctx(data, ncfg.get("url"))

    def forget(prefix):
        state["standings"] = {k: v for k, v in state["standings"].items() if not k.startswith(prefix)}
        state["pending"] = {k: v for k, v in state["pending"].items() if not k.startswith(prefix)}

    # When what's measured or how much it counts changes (a scoring override included), what was kept under the old
    # rules is dropped and learnt again silently: a changed rule isn't news. With the default rules the marks stay what
    # they were before rules were configurable.
    D = scoring.defaults()
    mark = lambda sec, base: base if c.rules[sec] == D[sec] else f"{base}:{scoring.digest(c.rules, sec)}"
    if state.get("card_scale") != (v := mark("cards", CARD_SCALE)):
        state["cards"], state["card_scale"] = {}, v
        forget("card:")
    if state.get("award_defs", 1) != (v := mark("titles", AWARD_DEFS)):
        forget("award:")
        state["award_defs"] = v
    if state.get("medal_defs", 1) != (v := mark("medals", 1)):
        forget("medal:")
        state["medal_defs"] = v
    if state.get("ms_defs", 1) != (v := mark("milestones", 1)):
        state["kinds"] = [k for k in state["kinds"] if k not in ("ms", "ph")]  # steps already passed aren't news
        state["ms_defs"] = v
    cards = state.setdefault("cards", {})  # player -> {tier: best ever, t: when reached}
    evs, P_all = events(c)
    cur, P_all = standings(c, P_all, data.get("world"))

    # (embed or None, [state updates to apply once it's out])
    out = []
    for eid, kind, _t, emb in evs:
        if eid in state["seen"]:
            continue
        if kind not in state["kinds"]:
            state["seen"][eid] = c.now  # new kind: history is not news
            continue
        out.append((emb, [("seen", eid)]))
    for k in [k for k in KINDS if k not in state["kinds"]]:
        state["kinds"].append(k)

    medal_changes = []
    for key, val in cur.items():
        old = state["standings"].get(key)
        if key not in state["standings"]:
            state["standings"][key] = val
            continue
        if val == old:
            state["pending"].pop(key, None)
            continue
        pend = state["pending"].get(key)
        since = pend[1] if pend and pend[0] == val and pend[1] > 1e9 else c.now  # [value, first seen]
        state["pending"][key] = [val, since]
        if c.now - since < DEBOUNCE:
            continue
        if key.startswith("medal:"):
            medal_changes.append((key, old, val))
        elif not old or set(val[0]) != set(old[0]):
            out.append((award_embed(c, key, old, val), [("standing", key, val)]))
        else:  # same holder, bigger number: not news
            out.append((None, [("standing", key, val)]))
    if medal_changes:
        out.append((medal_embed(c, medal_changes, P_all), [("standing", k, v) for k, _, v in medal_changes]))

    # trading cards only ever evolve: a new best tier that holds for DEBOUNCE is news, a drop is not
    for p, (tier, st) in card_tiers(c, P_all, data.get("world")).items():
        key, best = f"card:{p}", cards.get(p)
        if best is None:  # first time we see this card: no history posting
            cards[p] = {"tier": tier, "t": c.now}
            continue
        if TIERS.index(tier) <= TIERS.index(best["tier"]):
            state["pending"].pop(key, None)
            continue
        pend = state["pending"].get(key)
        since = pend[1] if pend and pend[0] == tier else c.now
        state["pending"][key] = [tier, since]
        if c.now - since >= DEBOUNCE:
            out.append((card_embed(c, p, tier, st), [("card", p, tier)]))

    def apply(marks):
        for m in marks:
            if m[0] == "seen":
                state["seen"][m[1]] = c.now
            elif m[0] == "card":
                cards[m[1]] = {"tier": m[2], "t": c.now}
                state["pending"].pop(f"card:{m[1]}", None)
            else:
                state["standings"][m[1]] = m[2]
                state["pending"].pop(m[1], None)

    for _, marks in [x for x in out if x[0] is None]:
        apply(marks)
    queue = [x for x in out if x[0] is not None]
    sent = 0
    for i in range(0, len(queue), 10):  # Discord: up to 10 embeds per message
        chunk = queue[i:i + 10]
        if dry:
            print(json.dumps([e for e, _ in chunk], ensure_ascii=False, indent=1))
        else:
            try:
                post(webhook, ncfg.get("username") or f"{data['title']} stats", [e for e, _ in chunk])
            except (urllib.error.URLError, OSError) as e:
                body = e.read().decode(errors="replace")[:200] if isinstance(e, urllib.error.HTTPError) else ""
                log(f"[{server['id']}] notify: post failed, retrying next run: {e} {body}")
                break
            time.sleep(1)
        for _, marks in chunk:
            apply(marks)
        sent += len(chunk)
    # live-event ids only need to outlive their RECENT window
    state["seen"] = {k: v for k, v in state["seen"].items()
                     if not k.startswith(("raid:", "spree:")) or c.now - v < 7 * DAY}
    if dry:
        return state
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    if queue:
        log(f"[{server['id']}] notify: posted {sent}/{len(queue)} embeds")
