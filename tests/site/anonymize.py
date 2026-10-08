#!/usr/bin/env python3
"""Turn a real server's data.json into the site tests' fixture: same shape and size, no one's names or words.

    python3 tests/site/anonymize.py live-data.json > tests/site/fixture/data.json

Players become Norse names (in order of their first session), pets "Pet N", signs "Sign N", portal tags "portalN",
map pins "Pin N"; title, id and links are replaced. Check the result before committing it: anything players typed
that isn't covered here stays.
"""
import json
import sys

NAMES = ["Ragnar", "Astrid", "Bjorn", "Sigrid", "Leif", "Freydis", "Ivar", "Halla", "Ulf", "Thyra", "Sven", "Gudrun"]


def main(path):
    with open(path) as f:
        data = json.load(f)
    players = []
    for s in sorted(data.get("sessions", []), key=lambda s: s["s"]):
        if s["p"] not in players:
            players.append(s["p"])
    if len(players) > len(NAMES):
        sys.exit(f"{len(players)} players, only {len(NAMES)} names")

    world = data.get("world") or {}
    pets = {}
    for p in data.get("pets", []):
        if p.get("n"):
            p["n"] = pets.setdefault(p["n"], f"Pet {len(pets) + 1}")
    world["named_tames"] = [[pets.setdefault(n, f"Pet {len(pets) + 1}"), s] for n, s in world.get("named_tames", [])]
    world["signs"] = [f"Sign {i + 1}" for i in range(len(world.get("signs", [])))]
    tags = {"": ""}  # one tag, one name: portals sharing a tag stay a pair
    lists = [world.get("portals", []), (world.get("map") or {}).get("portals", []), (data.get("portals_live") or {}).get("list", [])]
    for rows in lists:
        for r in rows:
            r[0] = tags.setdefault(r[0], f"portal{len(tags)}")
    for i, r in enumerate((world.get("map") or {}).get("pins", [])):
        r[0] = f"Pin {i + 1}" if r[0] else r[0]
    data.update({"id": "test", "title": "Test Valheim", "support": {"url": "https://example.com/support", "label": "Support"}})

    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for real in sorted(players, key=len, reverse=True):  # longest first: a name inside another one
        text = text.replace(json.dumps(real, ensure_ascii=False)[1:-1], NAMES[players.index(real)])
    sys.stdout.write(text + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
