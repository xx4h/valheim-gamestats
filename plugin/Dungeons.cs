// Logs who went into which dungeon and for how long, for the gamestats collector.
//
// The game builds a dungeon's interior (crypts, caves, the infested mine) high
// above the map — about 5000 m up, straight above its entrance — and moves the
// player there through the door. So a player whose character is above
// InsideAbove is inside one, and the location placed nearest below them is the
// one they came in through. Checked every 2 s from the players' synced positions:
//   [Gamestats] {"e":"enter","p":"Ragnar","i":"Crypt3","x":-1234,"z":567,"n":1}
//   [Gamestats] {"e":"leave","p":"Ragnar","i":"Crypt3","x":-1234,"z":567,"n":1,"s":412}
// x / z: the entrance (a world location, exact like the altars on the map);
// s: seconds inside. Not summed: one line each.
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Dungeons
    {
        private const float InsideAbove = 3000f;
        private const float EntranceRange = 120f; // 2D, from the interior's position to its entrance

        private class Visit
        {
            public string Player;
            public string Location;
            public Vector3 Entrance;
            public float Since;
        }

        private static readonly Dictionary<long, Visit> Inside = new Dictionary<long, Visit>();

        internal static void Tick()
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer() || ZoneSystem.instance == null)
                return;
            var seen = new HashSet<long>();
            foreach (var peer in ZNet.instance.GetPeers())
            {
                seen.Add(peer.m_uid);
                var character = ZDOMan.instance.GetZDO(peer.m_characterID);
                if (character == null)
                    continue;
                var pos = character.GetPosition();
                var now = Time.time;
                Inside.TryGetValue(peer.m_uid, out var visit);
                if (pos.y > InsideAbove && visit == null)
                {
                    var (name, entrance) = EntranceBelow(pos);
                    visit = new Visit { Player = peer.m_playerName, Location = name, Entrance = entrance, Since = now };
                    Inside[peer.m_uid] = visit;
                    Log("enter", visit, -1);
                }
                else if (pos.y <= InsideAbove && visit != null)
                {
                    Inside.Remove(peer.m_uid);
                    Log("leave", visit, Mathf.RoundToInt(now - visit.Since));
                }
            }
            // logged off (or died) inside: the visit ends with the connection
            var gone = new List<long>();
            foreach (var kv in Inside)
                if (!seen.Contains(kv.Key))
                    gone.Add(kv.Key);
            foreach (var uid in gone)
            {
                Log("leave", Inside[uid], Mathf.RoundToInt(Time.time - Inside[uid].Since));
                Inside.Remove(uid);
            }
        }

        // The placed location straight below an interior position: its prefab name and position.
        private static (string, Vector3) EntranceBelow(Vector3 pos)
        {
            string best = "?";
            var at = new Vector3(pos.x, 0f, pos.z);
            var bestDistance = EntranceRange;
            foreach (var li in ZoneSystem.instance.m_locationInstances.Values)
            {
                if (!li.m_placed || li.m_location == null)
                    continue;
                var d = new Vector2(li.m_position.x - pos.x, li.m_position.z - pos.z).magnitude;
                if (d < bestDistance)
                {
                    bestDistance = d;
                    best = li.m_location.m_prefabName;
                    at = li.m_position;
                }
            }
            return (best, at);
        }

        private static void Log(string e, Visit v, int seconds)
        {
            var sb = new StringBuilder("{\"e\":");
            Gather.Json(sb, e).Append(",\"p\":");
            Gather.Json(sb, v.Player).Append(",\"i\":");
            Gather.Json(sb, v.Location).Append(",\"x\":").Append(Mathf.RoundToInt(v.Entrance.x)).Append(",\"z\":").Append(Mathf.RoundToInt(v.Entrance.z))
                .Append(",\"n\":1");
            if (seconds >= 0)
                sb.Append(",\"s\":").Append(seconds);
            Events.Emit(sb.Append('}').ToString());
        }
    }
}
