"""Steam achievements (steam.py): the Web API's answers — in its own shapes — into the page's "steam" block, which
names characters, never Steam IDs."""
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from unittest import mock

from logs import read_json, write_json  # first: puts collector/ (the package's directory) on the path

from valheim_gamestats import steam

SID_A, SID_B = "76561190000000001", "76561190000000002"
SERVER = {"id": "test", "steam": {"app": 892970, "interval": 600}}
ICON = "a" * 40 + ".jpg"


def api(path, **params):
    """The Steam Web API, canned."""
    if path.startswith("ISteamUserStats/GetSchemaForGame"):
        return {"game": {"availableGameStats": {"achievements": [
            {"name": "Arrived", "displayName": "I Have Arrived!", "hidden": 1, "icon": f"https://cdn/x/{ICON}", "icongray": "x"},
            {"name": "Boss1Eikthyr", "displayName": "Eikthyr", "description": "", "hidden": 1},
            {"name": "BuildHouse", "displayName": "Comfort", "description": "Build a house."},
        ]}}}
    if path.startswith("ISteamUserStats/GetGlobalAchievementPercentagesForApp"):
        return {"achievementpercentages": {"achievements": [{"name": "Arrived", "percent": "95.5"}]}}
    if path.startswith("ISteamUserStats/GetPlayerAchievements"):
        if params["steamid"] == SID_B:  # a private profile answers 403, _get hands over the body
            return {"playerstats": {"error": "Profile is not public", "success": False}}
        return {"playerstats": {"success": True, "achievements": [
            {"apiname": "Arrived", "achieved": 1, "unlocktime": 1790000000},
            {"apiname": "BuildHouse", "achieved": 0, "unlocktime": 0}]}}
    if path.startswith("ISteamUserStats/GetUserStatsForGame"):
        return {"playerstats": {"stats": [{"name": "Deaths", "value": 12}]}}
    raise AssertionError(path)


class Steam(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "accounts.json"), "w") as f:
            json.dump({SID_A: ["Ragnar"], SID_B: ["Astrid", "Astrid2"]}, f)
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.dir)

    def update(self, now=1_791_400_000):
        def get(path, **params):
            self.calls.append(path.split("/")[1])
            return api(path, **params)
        with mock.patch.object(steam, "_get", get), \
                mock.patch.object(steam, "_icon", lambda app, url, d: ICON if url and ICON in url else None), \
                mock.patch.object(steam.time, "time", lambda: now):
            steam.update(SERVER, self.dir, self.dir, "key")

    def test_public_names_characters_not_accounts(self):
        self.update()
        pub = steam.public(self.dir, 892970)
        self.assertEqual(sorted(pub["players"]), ["Astrid", "Ragnar"])
        self.assertNotIn(SID_A, json.dumps(pub))
        self.assertEqual(pub["players"]["Ragnar"]["unlocked"], {"Arrived": 1790000000})
        self.assertEqual(pub["players"]["Ragnar"]["stats"], {"Deaths": 12})
        self.assertEqual(pub["players"]["Astrid"]["status"], "private")

    def test_achievements(self):
        self.update()
        a = {x["k"]: x for x in steam.public(self.dir, 892970)["achievements"]}
        self.assertEqual((a["Arrived"]["pct"], a["Arrived"]["icon"]), (95.5, ICON))
        self.assertEqual(a["Boss1Eikthyr"]["d"], "Defeat Eikthyr.")  # hidden: our own description
        self.assertIsNone(a["BuildHouse"]["pct"])

    def test_rate_limited(self):
        self.update()
        n = len(self.calls)
        self.update(now=1_791_400_000 + 60)  # a minute later: nothing is due
        self.assertEqual(len(self.calls), n)
        self.update(now=1_791_400_000 + 700)  # players again, schema not before tomorrow
        self.assertNotIn("GetSchemaForGame", self.calls[n:])
        self.assertIn("GetPlayerAchievements", self.calls[n:])

    def test_private_keeps_what_was_public(self):
        self.update()
        st = read_json(os.path.join(self.dir, "steam.json"))
        st["players"][SID_B].update(ok=True, unlocked={"Arrived": 1}, t=0)
        write_json(os.path.join(self.dir, "steam.json"), st)
        self.update(now=1_791_400_000 + 700)
        p = steam.public(self.dir, 892970)["players"]["Astrid"]
        self.assertEqual((p["status"], p["unlocked"]), ("private", {"Arrived": 1}))

    def test_gone_accounts_dropped(self):
        self.update()
        write_json(os.path.join(self.dir, "accounts.json"), {SID_A: ["Ragnar"]})
        self.update(now=1_791_400_000 + 700)
        self.assertNotIn(SID_B, read_json(os.path.join(self.dir, "steam.json"))["players"])

    def test_no_schema_no_block(self):
        self.assertIsNone(steam.public(self.dir, 892970))

    def test_icon_names_only_from_steam(self):
        # only content-hashed names are fetched and stored: never a path from the API's answer
        with mock.patch.object(steam.urllib.request, "urlopen", side_effect=AssertionError("fetched")):
            self.assertIsNone(steam._icon(892970, "https://cdn/../../etc/passwd", self.dir))
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b"jpg"
        with mock.patch.object(steam.urllib.request, "urlopen", return_value=resp):
            self.assertEqual(steam._icon(892970, f"https://cdn/x/{ICON}", self.dir), ICON)
        self.assertTrue(os.path.exists(os.path.join(self.dir, ICON)))

    def test_private_profile_403_body(self):
        body = io.BytesIO(json.dumps({"playerstats": {"error": "Profile is not public"}}).encode())
        err = urllib.error.HTTPError("u", 403, "Forbidden", {}, body)
        with mock.patch.object(steam.urllib.request, "urlopen", side_effect=err):
            self.assertEqual(steam._get("x/y")["playerstats"]["error"], "Profile is not public")


if __name__ == "__main__":
    unittest.main()
