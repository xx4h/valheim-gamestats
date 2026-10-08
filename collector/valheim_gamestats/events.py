"""The events everything is built from, in SQLite (<server-id>/events.db) — nothing from the game server's log.

Source: the plugin's own store on the game server (plugin/EventStore.cs). sync() asks it over RCON
(`gs_events <after>`) for what came after the last number it has, until nothing new comes; sync_files() reads the
same day files through the world's file source (sources.py) while RCON can't be reached (the server is
down). Each store has an id;
a new id (a wiped store) starts its numbers again, and a gap in the numbers is exactly what went missing — both are
reported to health.py.

History from before the plugin kept its own store was read from the server log (Loki) into archive.jsonl;
import_archive() converts it once (from_line) into the same events, up to the store's first event. The file stays
as it was, as a backup.

An event is a dict: "t" (seconds), "e" (kind), "p" (player, may be ""), "i", "n" and the kind's own fields — the
plugin's line as it is. Kinds that came from the game's own log lines: start, stop, login, spawn, death, logout,
raid, raidend, sleep, server; from old archives also platform (a Steam id connecting) and location (a location
placed in a zone, before the zone event had it).

Stdlib only.
"""
import json
import os
import re
import sqlite3
import time

from . import rcon

NS = 1_000_000_000
LEGACY = "log"  # the source name of events converted from the old archive
MAX_CALLS = 300  # gs_events calls per run (~1 MB): a long outage catches up over a few runs


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


def open_db(sdir):
    db = sqlite3.connect(os.path.join(sdir, "events.db"))
    db.execute("PRAGMA temp_store = MEMORY")  # sorting spills to /tmp otherwise, and the container's root is read-only
    db.executescript("""
        CREATE TABLE IF NOT EXISTS events (src TEXT NOT NULL, seq INTEGER NOT NULL, t REAL NOT NULL, e TEXT NOT NULL,
                                           body TEXT NOT NULL, PRIMARY KEY (src, seq));
        CREATE INDEX IF NOT EXISTS events_t ON events (t);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    """)
    return db


def meta(db, k, default=None):
    row = db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
    return json.loads(row[0]) if row else default


def set_meta(db, k, v):
    db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, json.dumps(v)))


def load(db, since=None):
    """Every event, oldest first."""
    rows = db.execute("SELECT t, body FROM events" + (" WHERE t >= ?" if since else "") + " ORDER BY t, src, seq",
                      (since,) if since else ())
    out = []
    for t, body in rows:
        ev = json.loads(body)
        ev["t"] = t
        out.append(ev)
    return out


def add(db, src, seq, ev):
    """One event (with "t"); False if it was there already."""
    body = {k: v for k, v in ev.items() if k != "t"}
    cur = db.execute("INSERT OR IGNORE INTO events (src, seq, t, e, body) VALUES (?, ?, ?, ?, ?)",
                     (src, seq, ev["t"], ev.get("e", ""), json.dumps(body, ensure_ascii=False, separators=(",", ":"))))
    return cur.rowcount > 0


# --------------------------------------------------------------------------
# From the plugin's store

# {"s":<number>,"t":<ms>,…the event…}: the store's two come first. Read them as that prefix (like the plugin does), not
# as JSON keys — an event can have its own "s" (sprint and dungeon seconds), and JSON keeps the last of two.
RE_STORE = re.compile(r'^\{"s":(\d+),"t":(\d+),')


def parse_store_line(line):
    """(number, event with "t") or None for a torn or foreign line."""
    if not (m := RE_STORE.match(line)):
        return None
    try:
        ev = json.loads("{" + line[m.end():])
    except ValueError:
        return None
    if not isinstance(ev, dict) or "e" not in ev:
        return None
    ev["t"] = int(m.group(2)) / 1000
    return int(m.group(1)), ev

def _store_lines(db, store, lines, status):
    """Add the store's lines after the cursor; returns how many were new. Notes gaps in status."""
    cursor = meta(db, "cursor", 0)
    added = 0
    for line in lines:
        if (parsed := parse_store_line(line)) is None:
            continue  # a torn line, never numbered
        seq, ev = parsed
        if seq <= cursor:
            continue
        if seq > cursor + 1:
            status.setdefault("gaps", []).append([cursor + 1, seq - 1])
        added += add(db, store, seq, ev)
        cursor = seq
        if meta(db, "cutover") is None:
            set_meta(db, "cutover", ev["t"])
    set_meta(db, "cursor", cursor)
    return added


def _header(db, head, status):
    """The reply's first line. A store we haven't seen: start from its beginning. Returns the header, and whether the
    cursor moved (the reply's events came after the old one: ask again)."""
    h = json.loads(head)
    before = meta(db, "cursor", 0)
    if h.get("error") or not h.get("id"):
        raise RuntimeError(f"event store: {h.get('error') or 'no store id'}")
    if h["id"] != meta(db, "store"):
        if meta(db, "store") is not None:
            status["new_store"] = h["id"]  # wiped or replaced: numbers start over
        set_meta(db, "store", h["id"])
        set_meta(db, "cursor", 0)
    if meta(db, "cursor", 0) > h["head"]:
        status["behind"] = [h["head"], meta(db, "cursor", 0)]  # the store has fewer than we read: it lost some
        set_meta(db, "cursor", h["head"])
    if meta(db, "cursor", 0) + 1 < h["oldest"]:
        status.setdefault("gaps", []).append([meta(db, "cursor", 0) + 1, h["oldest"] - 1])  # pruned before we read it
        set_meta(db, "cursor", h["oldest"] - 1)
    return h, meta(db, "cursor", 0) != before


def sync(server, db, password):
    """Fetch everything new over RCON. Returns {"added", "head", "gaps"?, "new_store"?, "behind"?}."""
    rc = server["rcon"]
    status = {"added": 0}
    with db:
        for _ in range(MAX_CALLS):
            out = rcon.command(rc["host"], rc.get("port", 25575), password, f"gs_events {meta(db, 'cursor', 0)}")[0]
            if out.startswith("Unknown command") or not out.startswith("{"):
                raise RuntimeError(f"gs_events: {out[:200]!r} — is the plugin (1.16.0+) loaded?")
            head, *lines = out.split("\n")
            h, moved = _header(db, head, status)
            status["head"] = h["head"]
            if moved:
                continue
            if not lines:
                break
            status["added"] += _store_lines(db, h["id"], lines, status)
            if meta(db, "cursor", 0) >= h["head"]:
                break
    return status


def sync_files(server, db, files):
    """The same from the store's day files through the world's file source (sources.py) — while RCON can't be reached.
    world.events: where they are, relative to the server's directory."""
    d = (server.get("world") or {}).get("events", "BepInEx/gamestats/events")
    status = {"added": 0, "files": True}
    listing = files.list(d)
    with db:
        store = files.get(f"{d}/store-id").decode().strip()
        if store != meta(db, "store"):
            if meta(db, "store") is not None:
                status["new_store"] = store
            set_meta(db, "store", store)
            set_meta(db, "cursor", 0)
        for name in sorted(n for n in listing if re.fullmatch(r"\d{4}-\d\d-\d\d\.jsonl", n)):
            last = meta(db, "last_file_day")
            if last and name < last:
                continue  # read before; the day we stopped at is read again
            lines = files.get(f"{d}/{name}").decode(errors="replace").split("\n")
            status["added"] += _store_lines(db, store, lines, status)
            set_meta(db, "last_file_day", name)
    return status


# --------------------------------------------------------------------------
# From the old archive (the server log, read from Loki before the plugin had its own store)

RE_CHAR = re.compile(r"Got character ZDOID from (.+) : (-?\d+):(\d+)\s*$")
RE_DESTROY = re.compile(r"Destroying abandoned non persistent zdo -?\d+:\d+ owner (-?\d+)\s*$")
RE_CONN = re.compile(r"Connections (\d+) ZDOS:(\d+)")
RE_EVENT = re.compile(r"Random event set:(\S+)")
RE_SLEEP = re.compile(r"Time ([\d.]+), day:\d+\s+nextm:([\d.]+)")
RE_LOC = re.compile(r"Placed location (\S+) in zone (-?\d+),(-?\d+)")
RE_VER = re.compile(r"Valheim version: (\S+)")
RE_PLATFORM = re.compile(r"received local Platform ID (\w+?_\S+)")
RE_PLUGIN = re.compile(r"\[Gamestats\] (\{.*\})\s*$")
RE_WARN = re.compile(r"\[Gamestats\] ([a-z]+): (.*?)\s*$")


def from_line(line, ctx):
    """One archived log line as an event (without "t"), or None. ctx: {} carried from line to line."""
    if (m := RE_PLUGIN.search(line)):
        try:
            ev = json.loads(m.group(1))
        except ValueError:
            return None
        return ev if isinstance(ev, dict) and "e" in ev else None
    if (m := RE_CHAR.search(line)):
        name, uid, n = m.group(1).strip(), m.group(2), int(m.group(3))
        if uid == "0":
            return {"e": "death", "p": name}
        return {"e": "spawn", "p": name, "uid": uid, "n": n}
    if (m := RE_DESTROY.search(line)):
        return {"e": "logout", "p": "", "uid": m.group(1)}
    if (m := RE_CONN.search(line)):
        return {"e": "server", "p": "", "n": int(m.group(1)), "zdos": int(m.group(2))}
    if "New session server" in line:
        return {"e": "start", "p": "", "game": ctx.get("version")}
    if (m := RE_EVENT.search(line)):
        return {"e": "raid", "p": "", "i": m.group(1)}
    if (m := RE_SLEEP.search(line)):
        return {"e": "sleep", "p": "", "time": float(m.group(1)), "to": float(m.group(2))}
    if (m := RE_LOC.search(line)):
        return {"e": "location", "p": "", "i": m.group(1), "x": int(m.group(2)), "y": int(m.group(3))}
    if (m := RE_VER.search(line)):
        ctx["version"] = m.group(1)
        return None
    if (m := RE_PLATFORM.search(line)):
        return {"e": "platform", "p": "", "i": m.group(1)}
    if (m := RE_WARN.search(line)):
        return {"e": "warn", "p": "", "i": m.group(1), "msg": m.group(2)}
    return None


def from_lines(rows, before=None):
    """[(ts_ns, line)] (sorted) → events, those before `before` (seconds) only."""
    ctx, out = {}, []
    for ts, line in rows:
        t = ts / NS
        if before is not None and t >= before:
            break
        if (ev := from_line(line, ctx)) is not None:
            ev["t"] = t
            out.append(ev)
    return out


def import_archive(db, sdir):
    """Once, when the store's first event is known: the archive up to it. Returns how many were imported."""
    cutover = meta(db, "cutover")
    path = os.path.join(sdir, "archive.jsonl")
    if cutover is None or meta(db, "archive_imported") or not os.path.exists(path):
        return 0
    with open(path) as f:
        rows = sorted(tuple(json.loads(r)) for r in f if r.strip())
    n = 0
    with db:
        for i, ev in enumerate(from_lines(rows, before=cutover)):
            n += add(db, LEGACY, i, ev)
        set_meta(db, "archive_imported", {"t": time.time(), "events": n, "before": cutover})
    log(f"archive: {n} events from the log before {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(cutover))} UTC")
    return n
