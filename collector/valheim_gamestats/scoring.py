"""What counts how much: the impact score, titles, Discord medals, badges, trading cards, traits, report-card grades and
milestones. docs/SCORING.md explains each of them, with the math.

The defaults are scoring.json, next to this file — the only place these numbers live. A server owner changes them with
overrides in config.json: `scoring` for every server, `servers[].scoring` for one (it wins). An override names only
what it changes; everything else stays as it is:

    {"impact": {"bonus": {"built": 30}}, "titles": {"ragequit": {"enabled": false}, "marathon": {"min": 7200}}}

publish() merges and checks them and returns what the page and the Discord feed compute from:
{"rules": the merged rules, without what's switched off, "changed": {dotted path: its default}}. A mistake (an unknown
key, a wrong type, steps out of order) is a ValueError naming every problem — the collector won't start with one.

    python3 -m valheim_gamestats.scoring check config.json     the overrides in a config, checked
    python3 -m valheim_gamestats.scoring show config.json [id] the rules a server ends up with
    python3 -m valheim_gamestats.scoring schema                the chart's values.schema.json

Stdlib only.
"""
import hashlib
import json
import os
import sys

DEFAULTS = os.path.join(os.path.dirname(__file__), "scoring.json")
# Sections whose entries can be switched off with "enabled": false.
COLLECTIONS = ("titles", "medals", "badges", "traits", "grades.subjects")
# How a metric works, not how much it counts: not overridable.
FIXED = ("low", "pair")
GRADE_STEPS = 5  # A+, A, B, C, D


def defaults():
    with open(DEFAULTS, encoding="utf-8") as f:
        return json.load(f)


def _is_num(v):
    return isinstance(v, int | float) and not isinstance(v, bool)


def _collection(path):
    return path in COLLECTIONS


def _apply(base, over, path, errors):
    """base with over merged in (base is a copy, changed in place); problems go into errors."""
    if not isinstance(over, dict):
        errors.append(f"{path or 'scoring'}: expected a mapping, got {over!r}")
        return
    for k, v in over.items():
        p = f"{path}.{k}" if path else k
        if _collection(path) and k in base:
            if not isinstance(v, dict):
                errors.append(f"{p}: expected a mapping, got {v!r}")
                continue
            for ek, ev in v.items():
                ep = f"{p}.{ek}"
                if ek == "enabled":
                    if isinstance(ev, bool):
                        base[k]["enabled"] = ev
                    else:
                        errors.append(f"{ep}: expected true or false, got {ev!r}")
                elif ek in FIXED:
                    errors.append(f"{ep}: fixed — it's how the metric works, not how much it counts")
                elif ek not in base[k]:
                    errors.append(f"{ep}: unknown — one of {', '.join([*base[k], 'enabled'])}")
                else:
                    _value(base[k], ek, ev, ep, errors)
            continue
        if k not in base:
            errors.append(f"{p}: unknown — one of {', '.join(base)}")
            continue
        _value(base, k, v, p, errors)


def _value(base, k, v, p, errors):
    d = base[k]
    if isinstance(d, dict):
        _apply(d, v, p, errors)
    elif isinstance(d, list) and d and isinstance(d[0], dict):  # badge_tiers: name and icon of each level
        if not isinstance(v, list) or len(v) != len(d) or not all(isinstance(x, dict) for x in v):
            errors.append(f"{p}: expected a list of {len(d)} entries like {d[0]}")
            return
        for i, x in enumerate(v):
            _apply(base[k][i], x, f"{p}[{i}]", errors)
    elif isinstance(d, list):
        if not isinstance(v, list) or not all(_is_num(x) and x >= 0 for x in v):
            errors.append(f"{p}: expected a list of numbers ≥ 0, got {v!r}")
        else:
            base[k] = v
    elif _is_num(d):
        if not _is_num(v) or v < 0:
            errors.append(f"{p}: expected a number ≥ 0, got {v!r}")
        else:
            base[k] = v
    elif isinstance(d, str):
        if not isinstance(v, str) or not v.strip():
            errors.append(f"{p}: expected a text, got {v!r}")
        else:
            base[k] = v
    else:
        errors.append(f"{p}: can't be changed")


def _ascending(xs):
    return all(a < b for a, b in zip(xs, xs[1:], strict=False))


def _check(r, errors):
    """What the types don't say: groups that exist, steps in order, tiers that fit."""
    for k, t in r["titles"].items():
        if t["group"] not in r["title_groups"]:
            errors.append(f"titles.{k}.group: {t['group']!r} isn't a group — one of {', '.join(r['title_groups'])}")
    n = len(r["badge_tiers"])
    for k, b in r["badges"].items():
        if len(b["steps"]) != n or not _ascending(b["steps"]):
            names = ", ".join(t["name"] for t in r["badge_tiers"])
            errors.append(f"badges.{k}.steps: {n} numbers, each bigger than the one before ({names})")
    for k, s in r["grades"]["subjects"].items():
        st = s["steps"]
        ok = len(st) == GRADE_STEPS and (_ascending(st) if s.get("low") else _ascending(st[::-1]))
        if not ok:
            want = "each bigger" if s.get("low") else "each smaller"
            errors.append(f"grades.subjects.{k}.steps: {GRADE_STEPS} numbers for A+, A, B, C, D, {want} than the one before")
    for k, v in r["milestones"].items():
        if isinstance(v, list) and not _ascending(v):
            errors.append(f"milestones.{k}: each number bigger than the one before")
    t = r["cards"]["tiers"]
    if not 0 < t["rare"] < t["epic"] < t["legendary"] <= 99:
        errors.append("cards.tiers: 0 < rare < epic < legendary ≤ 99")
    for k, v in r["cards"]["at"].items():
        if v <= 0:
            errors.append(f"cards.at.{k}: must be more than 0")
    if r["cards"]["dph"] <= 0:
        errors.append("cards.dph: must be more than 0")
    if not any(v > 0 for v in r["impact"]["bonus"].values()):
        errors.append("impact.bonus: at least one weight above 0")


def _diff(new, old, path, out):
    if isinstance(old, dict) and isinstance(new, dict):
        for k in new:
            p = f"{path}.{k}" if path else k
            if k == "enabled" and k not in old:
                if new[k] is False:
                    out[p] = True
            elif k in old:
                _diff(new[k], old[k], p, out)
    elif new != old:
        out[path] = old


def merge(*overrides):
    """The defaults with each override applied in turn: (rules, changed). Raises ValueError with every problem."""
    base, errors = defaults(), []
    for o in overrides:
        if o:
            _apply(base, o, "", errors)
    if not errors:
        _check(base, errors)
    if errors:
        raise ValueError("scoring: " + "; ".join(errors))
    changed = {}
    _diff(base, defaults(), "", changed)
    for path in COLLECTIONS:
        sec = base
        for part in path.split("."):
            sec = sec[part]
        for k in [k for k, e in sec.items() if e.pop("enabled", True) is False]:
            del sec[k]
    return base, changed


def publish(cfg, server):
    """What a server's page and feed compute from: {"rules", "changed"} (cfg["scoring"], then server["scoring"])."""
    try:
        rules, changed = merge(cfg.get("scoring"), server.get("scoring"))
    except ValueError as e:
        raise ValueError(f"[{server.get('id')}] {e}") from None
    return {"rules": rules, "changed": changed}


def digest(rules, *sections):
    """A short hash of some sections: notify.py starts over silently when the rules it posts by change."""
    raw = json.dumps([rules.get(s) for s in sections], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def schema():
    """JSON Schema of the overrides, for the chart's values.schema.json: Helm refuses a typo before the collector does."""
    def of(d, path=""):
        if isinstance(d, dict):
            props = {}
            for k, v in d.items():
                if k in FIXED:
                    continue
                props[k] = of(v, f"{path}.{k}" if path else k)
                if _collection(path):
                    props[k]["properties"]["enabled"] = {"type": "boolean"}
            return {"type": "object", "additionalProperties": False, "properties": props}
        if isinstance(d, list) and d and isinstance(d[0], dict):
            return {"type": "array", "minItems": len(d), "maxItems": len(d), "items": of(d[0], path)}
        if isinstance(d, list):
            return {"type": "array", "items": {"type": "number", "minimum": 0}}
        if _is_num(d):
            return {"type": "number", "minimum": 0}
        return {"type": "string", "minLength": 1}

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "valheim-gamestats values — only scoring is checked here (collector/valheim_gamestats/scoring.py)",
        "type": "object",
        "properties": {
            "scoring": {"$ref": "#/definitions/scoring"},
            "servers": {"type": "array",
                        "items": {"type": "object", "properties": {"scoring": {"$ref": "#/definitions/scoring"}}}},
        },
        "definitions": {"scoring": of(defaults())},
    }


def main(argv):
    if argv[:1] == ["schema"]:
        print(json.dumps(schema(), ensure_ascii=False, indent=2))
        return 0
    if argv[:1] in (["check"], ["show"]) and len(argv) >= 2:
        with open(argv[1], encoding="utf-8") as f:
            cfg = json.load(f)
        servers = [s for s in cfg.get("servers", []) if len(argv) < 3 or s.get("id") == argv[2]]
        try:
            out = {s["id"]: publish(cfg, s) for s in servers}
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        if argv[0] == "show":
            print(json.dumps(out, ensure_ascii=False, indent=1))
        else:
            for sid, p in out.items():
                print(f"{sid}: ok, {len(p['changed'])} changed{': ' + ', '.join(p['changed']) if p['changed'] else ''}")
        return 0
    print(__doc__.split("\n\n")[-2], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
