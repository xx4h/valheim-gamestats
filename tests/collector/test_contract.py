"""docs/events.json stays true: every event the plugin can send is in it, every entry is covered by tests that exist
and are about it. (That data.json has exactly its "data" keys is test_build's job.)"""
import ast
import glob
import os
import re
import unittest

from logs import read_json  # first: puts collector/ (the package's directory) on the path

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
CONTRACT = read_json(os.path.join(ROOT, "docs", "events.json"))

# The plugin's emit helpers (Gather.Add, Custody.Log, Dungeons' Log, Gather's Credit, Vitals' Event, Server's Player,
# CombatCore's _add):
# the event's name is a string literal among their first two arguments ("take" and "off" both, for a ternary).
EMIT = re.compile(r'(?:\bGather\.Add|(?<![\w.])Add|(?<![\w.])_add|\bCustody\.Log|(?<![\w.])Log|(?<![\w.])Credit'
                  r'|(?<![\w.])Event|(?<![\w.])Player)\(([^,;)]*(?:,[^,;)]*)?)')


def plugin_events():
    """{event: {source files}} — every name the plugin's code can send."""
    found = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "plugin", "*.cs"))):
        name = os.path.basename(path)
        with open(path) as f:
            src = re.sub(r"//[^\n]*", "", f.read())  # comments name events too
        names = [lit for m in EMIT.finditer(src) for lit in re.findall(r'"([a-z_]+)"', m.group(1))]
        names += re.findall(r'\\"e\\":\\"([a-z_]+)', src)  # written out: {"e":"pethp", …
        if re.search(r"\bstatic void Warn\(", src):  # Events.Warn: every problem is a "warn" event too
            names.append("warn")
        for n in names:
            found.setdefault(n, set()).add(name)
    return found


# events the test helpers in logs.py write (as the game's or the plugin's log lines), by the helper's name
HELPERS = {"plugin": ".plugin(", "location": ".location(", "platform": ".connect(", "death": ".death(", "spawn": ".spawn(",
           "logout": ".logout(", "start": ".restart(", "server": ".players(", "raid": ".raid(", "zone": ".zone(",
           "warn": ".warn("}


def tests():
    """{"module.Class.test": source of the test} for every collector test."""
    out = {}
    for path in glob.glob(os.path.join(os.path.dirname(__file__), "test_*.py")):
        module = os.path.basename(path)[:-3]
        with open(path) as f:
            src = f.read()
        for cls in ast.parse(src).body:
            if isinstance(cls, ast.ClassDef):
                for fn in cls.body:
                    if isinstance(fn, ast.FunctionDef) and fn.name.startswith("test_"):
                        out[f"{module}.{cls.name}.{fn.name}"] = ast.get_source_segment(src, fn)
    return out


class Contract(unittest.TestCase):
    def test_plugin_sends_only_what_the_contract_knows(self):
        sent, known = plugin_events(), CONTRACT["events"]
        self.assertGreater(len(sent), 40, "the scan found too little: has the plugin's way of sending changed?")
        self.assertEqual(sorted(set(sent) - set(known)), [], "events the plugin sends that docs/events.json doesn't list")
        self.assertEqual(sorted(set(known) - set(sent)), [], "events docs/events.json lists that the plugin never sends")

    def test_sent_from_where_the_contract_says(self):
        sent = plugin_events()
        for e, c in CONTRACT["events"].items():
            with self.subTest(event=e):
                self.assertIn(c["from"], sent.get(e, set()))

    def test_every_entry_is_tested(self):
        have = tests()
        for section in ("events", "legacy", "data"):
            for name, c in CONTRACT[section].items():
                with self.subTest(section=section, name=name):
                    self.assertTrue(c["tests"], "no tests")
                    for t in c["tests"]:
                        self.assertIn(t, have, f"test {t} doesn't exist")

    def test_event_tests_are_about_the_event(self):
        # a test listed for an event names it — or goes through the contract's own list (EveryKind)
        have = tests()
        for section in ("events", "legacy"):
            for e, c in CONTRACT[section].items():
                with self.subTest(event=e):
                    self.assertTrue(any(f'"{e}"' in have[t] or f"e={e!r}" in have[t].replace('"', "'") or "CONTRACT" in have[t]
                                        or (e in HELPERS and HELPERS[e] in have[t]) for t in c["tests"]),
                                    f"none of {c['tests']} mentions {e!r}")

    def test_scan_sees_every_way_of_sending(self):
        # the scanner itself, on the forms the plugin uses
        src = r'''Gather.Add("pick", p, i, 1); Add("fell", p); Custody.Log(k ? "take" : "off", p); Event(p, "sprint", x);
                  Player("death", peer); Credit("mine", n, pos); var s = "{\"e\":\"zone\""; list.Add("nope");
                  _add("kill", p, mob, 1);'''
        names = ([lit for m in EMIT.finditer(src) for lit in re.findall(r'"([a-z_]+)"', m.group(1))] +
                 re.findall(r'\\"e\\":\\"([a-z_]+)', src))
        self.assertEqual(sorted(names), ["death", "fell", "kill", "mine", "off", "pick", "sprint", "take", "zone"])


if __name__ == "__main__":
    unittest.main()
