"""data.json in pieces, so a page that's open only fetches what changed (site/app.js: loadData).

    site/<id>/index.json        the only file that changes in place: which of the files below make up the data now
    site/<id>/c/<name>.json     everything else, named by content hash: cached by browsers for good (nginx: immutable)

The history (SERIES: lists whose entries never change once they're over) is split by when each entry happened, UTC:
  older than the last 4 whole weeks   one file per month
  the 4 weeks before this one         one file per week
  this week before today              one file per day
  today, and whatever is still open   live — with the state that changes every minute (FAST)
Everything else is state: entries that change, or no history at all. Each part that changes on its own clock is a file
of its own (OWN), so a gear move doesn't make every page fetch the world again; the rest is one file, "state".

So an open page fetches index.json (≈1 KB) every poll, live once a minute, state when the hourly save changed it and a
new day file once a day. A late event (an outage the collector caught up on) changes an older file's content, hence its
name: the page fetches it again, nothing stale stays cached. Joining the files back (merge) gives exactly the data.

Stdlib only.
"""
import hashlib
import json
import os
import time

DAY, WEEK = 86400, 7 * 86400
MONDAY = 4 * DAY  # 1970-01-01 was a Thursday: weeks start on Monday 00:00 UTC
WEEKS = 4         # whole weeks kept as week files before they fold into months
KEEP = 3600       # files no longer in the index stay this long (a page may have just read the old index)

# Lists of entries that are done once they're over, and when each happened (the key the page sorts them by).
SERIES = {
    "sessions": lambda x: x["s"], "deaths": lambda x: x["t"], "raids": lambda x: x["t"], "days": lambda x: x["t"],
    "restarts": lambda x: x, "zones": lambda x: x["t"], "samples": lambda x: x[0], "gather": lambda x: x[0],
    "visits": lambda x: x[0], "peaks": lambda x: x[0], "feats": lambda x: x[0], "world_history": lambda x: x["t"],
}
# entries still open: they change until they're over, so they ride in live until then
OPEN = {"sessions": lambda x: x.get("e") is None, "visits": lambda x: x[5] is None}
# state that changes every minute
FAST = ("generated", "online", "clock", "day", "positions", "equipment", "portals_live", "keys_live", "key_times")
# state with a clock of its own: the world and pets with the hourly save, custody with every gear move, Steam with its
# checks (one account every few minutes), the scoring rules with the config
OWN = ("world", "pets", "custody", "steam", "scoring")


def _week(t):
    return (int(t) - MONDAY) // WEEK * WEEK + MONDAY


def _month(t):
    y, m = time.gmtime(t)[:2]
    return f"{y:04d}-{m:02d}"


def bucket(t, now):
    """Which file an entry from time t goes into: ("m", "2026-09"), ("w", "2026-09-28"), ("d", "2026-10-06") or live."""
    today, week = int(now) // DAY * DAY, _week(now)
    if t >= today:
        return ("live", "")
    if t >= week:
        return ("d", time.strftime("%Y-%m-%d", time.gmtime(int(t) // DAY * DAY)))
    if t >= week - WEEKS * WEEK:
        return ("w", time.strftime("%Y-%m-%d", time.gmtime(_week(t))))
    return ("m", _month(t))


def split(data, now=None):
    """data.json -> (index, {file name: content}); index["files"] lists them in the order merge() needs (oldest first)."""
    now = data["generated"] if now is None else now
    parts, live = {}, {k: data[k] for k in FAST if k in data}
    for key, when in SERIES.items():
        for x in data.get(key, []):
            b = ("live", "") if key in OPEN and OPEN[key](x) else bucket(when(x), now)
            (live if b[0] == "live" else parts.setdefault(b, {})).setdefault(key, []).append(x)
        if key in data:
            live.setdefault(key, [])  # an empty list stays a list (nothing in it yet is not "no such list")
    own = {k: {k: data[k]} for k in OWN if k in data}
    state = {k: v for k, v in data.items() if k not in SERIES and k not in FAST and k not in OWN}
    files, order = {}, []

    def put(kind, body):
        # sorted keys: the same content, the same name. Not the rules: their order is the page's order (groups, titles),
        # and they come from scoring.json in a fixed one anyway.
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=kind != "scoring")
        name = f"{kind}-{hashlib.sha256(raw.encode()).hexdigest()[:16]}.json"
        files[name] = raw
        order.append(name)
        return name

    rank = {"m": 0, "w": 1, "d": 2}
    for (kind, label), body in sorted(parts.items(), key=lambda kv: (rank[kv[0][0]], kv[0][1])):
        put(f"{kind}{label}", body)
    for k, body in own.items():
        put(k, body)
    put("state", state)
    put("live", live)
    return {"v": 1, "generated": data["generated"], "files": order}, files


def merge(index, files):
    """Back from the files: concatenated per series, put in time order (what's still open sits in live) — the data."""
    data = {}
    for name in index["files"]:
        for k, v in files[name].items():
            if k in SERIES:
                data.setdefault(k, []).extend(v)
            else:
                data[k] = v
    for k, when in SERIES.items():
        if k in data:
            data[k].sort(key=when)
    return data


def write(outdir, data, now=None):
    """Write the files that are new, then index.json; remove files the index has left behind for KEEP."""
    index, files = split(data, now)
    cdir = os.path.join(outdir, "c")
    os.makedirs(cdir, exist_ok=True)
    for name, raw in files.items():
        path = os.path.join(cdir, name)
        if not os.path.exists(path):  # same name, same content
            with open(path + ".tmp", "w") as f:
                f.write(raw)
            os.replace(path + ".tmp", path)
    with open(os.path.join(outdir, ".index.json.tmp"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    os.replace(os.path.join(outdir, ".index.json.tmp"), os.path.join(outdir, "index.json"))
    wall = time.time()
    for name in os.listdir(cdir):
        path = os.path.join(cdir, name)
        if name not in files and wall - os.path.getmtime(path) > KEEP:
            os.remove(path)
    return index


if __name__ == "__main__":  # python3 -m valheim_gamestats.chunks data.json outdir: the same files from a data.json (site tests)
    import sys

    from . import scoring
    with open(sys.argv[1]) as f:
        data = json.load(f)
    data.setdefault("scoring", scoring.publish({}, {}))  # a data.json from before the rules were published: the defaults
    write(sys.argv[2], data)
