// Deaths of tamed creatures ("pets"), for the gamestats pets page.
//
// The hourly world save tells the collector which pets exist (identity: prefab +
// BaseAI's spawntime, which survives saves and restarts, unlike ZDO ids). What a
// save can't tell is when and how one died. Every tame's death reaches the server
// as the deletion of its ZDO (Combat.OnDestroyed), with its last synced state
// still there, so this logs one line per death:
//
//   [Gamestats] {"e":"petdeath","p":name,"i":prefab,"n":1,"k":"<prefab>:<spawntime>","x","z","hp",
//                "by":[players who hit it],"near":"<closest hostile creature>","nd":<its distance in m>}
//
// The game never tells the server which creature dealt a hit, so "near" is the
// nearest untamed creature within NearRange at that moment — a likely killer,
// not a certain one. Young that grow up are deleted too (Growup spawns the adult),
// with health left: not deaths. Summons (Troll_Summoned, …) are tamed but expire.
//
// Health history (1.7.0): every health change of a pet (Combat.OnHealthChanged), summed per
// minute and pet, one line each:
//
//   [Gamestats] {"e":"pethp","p":name,"i":prefab,"n":1,"k":key,"dmg","hits","heal","min","hp","max",
//                "by":{"<player>"|"~<creature>"|"?": damage}}
//
// A drop goes to the players in the pet's attacker list who swung or shot in the 3 s before
// (Attacks.cs); else to the nearest untamed creature that moved within NearRange in the last
// AroundSeconds ("~Troll*1", a guess); else to "?" (fall, fire, water). Rises are healing
// (BaseAI regenerates every creature by its max health per hour). The world only runs near
// players, so a pen nobody is near has no history: nothing can happen there.
using System.Collections.Generic;
using System.Text;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Pets
    {
        private const float NearRange = 30f;
        private static readonly HashSet<string> Young = new HashSet<string> { "Wolf_cub", "Boar_piggy", "Lox_Calf", "Chicken", "Asksvin_hatchling" };
        private static readonly int PlayerHash = "Player".GetStableHashCode();
        private const float AroundSeconds = 30f, HitWindow = 3f;

        // untamed creatures that sent an update lately: who is around when a pet gets hurt, without a full scan per hit
        private static readonly Dictionary<ZDOID, (Vector3 Pos, float Time, string Name)> Around = new Dictionary<ZDOID, (Vector3, float, string)>();

        private class Acc
        {
            public string Name, Prefab;
            public float Dmg, Heal, Min = float.MaxValue, Hp, Max;
            public int Hits;
            public readonly Dictionary<string, float> By = new Dictionary<string, float>();
        }
        private static readonly Dictionary<string, Acc> Minute = new Dictionary<string, Acc>();

        private static bool IsPet(ZDO zdo, string prefab) =>
            zdo.GetBool(ZDOVars.s_tamed) && !prefab.EndsWith("_Summoned") && !prefab.EndsWith("_Friendly");

        private static string Key(ZDO zdo, string prefab) => $"{prefab}:{zdo.GetLong(ZDOVars.s_spawnTime, 0L)}";

        // Every creature update (Combat.OnHealthChanged): track the untamed, account the pets.
        internal static void OnUpdate(ZDO zdo, float before, float maxBefore)
        {
            var prefabHash = zdo.GetPrefab();
            if (prefabHash == PlayerHash)
                return;
            if (!zdo.GetBool(ZDOVars.s_tamed))
            {
                var level = zdo.GetInt(ZDOVars.s_level, 1);
                var name = Gather.PrefabName(zdo);
                Around[zdo.m_uid] = (zdo.GetPosition(), Time.time, level > 1 ? $"{name}*{level - 1}" : name);
                return;
            }
            var prefab = Gather.PrefabName(zdo);
            if (!IsPet(zdo, prefab))
                return;
            var after = zdo.GetFloat(ZDOVars.s_health, before);
            var max = zdo.GetFloat(ZDOVars.s_maxHealth, maxBefore);
            var key = Key(zdo, prefab);
            if (!Minute.TryGetValue(key, out var a))
                Minute[key] = a = new Acc { Prefab = prefab };
            a.Name = zdo.GetString(ZDOVars.s_tamedName);
            a.Hp = after;
            a.Max = max;
            if (after < before - 0.01f)
            {
                var lost = before - Mathf.Max(after, 0f);
                a.Dmg += lost;
                a.Hits++;
                a.Min = Mathf.Min(a.Min, after);
                var by = Source(zdo);
                a.By.TryGetValue(by, out var have);
                a.By[by] = have + lost;
            }
            else if (after > before + 0.01f && Mathf.Abs(max - maxBefore) < 0.01f)  // a new max (growing up) is no healing
            {
                a.Heal += after - before;
            }
        }

        // Who caused the drop that just synced: players who attacked it lately, else the nearest creature around, else "?".
        private static string Source(ZDO pet)
        {
            var now = Time.time;
            if (pet.GetInt(ZDOVars.s_attackers) > 0)
                foreach (var peer in ZNet.instance.GetPeers())
                    if (!string.IsNullOrEmpty(peer.m_playerName) && pet.GetBool(ZDOVars.s_attackers + peer.m_playerName)
                        && System.Linq.Enumerable.Any(Attacks.Between(peer.m_playerName, now - HitWindow, now)))
                        return peer.m_playerName;
            var pos = pet.GetPosition();
            string best = null;
            var bestDist = NearRange;
            foreach (var kv in Around)
            {
                if (now - kv.Value.Time > AroundSeconds)
                    continue;
                var d = Vector3.Distance(kv.Value.Pos, pos);
                if (d < bestDist)
                {
                    best = kv.Value.Name;
                    bestDist = d;
                }
            }
            return best != null ? "~" + best : "?";
        }

        // Once a minute, with Gather.Flush.
        internal static void Flush()
        {
            foreach (var kv in Minute)
            {
                var a = kv.Value;
                if (a.Dmg < 0.5f && a.Heal < 0.5f)
                    continue;
                var sb = new StringBuilder("{\"e\":\"pethp\"");
                sb.Append(",\"p\":").Append(Json(a.Name)).Append(",\"i\":").Append(Json(a.Prefab)).Append(",\"n\":1");
                sb.Append(",\"k\":").Append(Json(kv.Key));
                sb.Append($",\"dmg\":{Mathf.RoundToInt(a.Dmg)},\"hits\":{a.Hits},\"heal\":{Mathf.RoundToInt(a.Heal)}");
                if (a.Hits > 0)
                    sb.Append($",\"min\":{Mathf.RoundToInt(Mathf.Max(a.Min, 0f))}");
                sb.Append($",\"hp\":{Mathf.RoundToInt(Mathf.Max(a.Hp, 0f))},\"max\":{Mathf.RoundToInt(a.Max)}");
                sb.Append(",\"by\":{");
                var first = true;
                foreach (var b in a.By)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(Json(b.Key)).Append(':').Append(Mathf.RoundToInt(b.Value));
                }
                Events.Emit(sb.Append("}}").ToString());
            }
            Minute.Clear();
            var now = Time.time;
            var stale = new List<ZDOID>();
            foreach (var kv in Around)
                if (now - kv.Value.Time > AroundSeconds)
                    stale.Add(kv.Key);
            foreach (var id in stale)
                Around.Remove(id);
        }

        internal static void OnDestroyed(ZDO zdo, string prefab)
        {
            if (!IsPet(zdo, prefab))
                return;
            var health = zdo.GetFloat(ZDOVars.s_health, zdo.GetFloat(ZDOVars.s_maxHealth, 1f));
            if (health > 0f && Young.Contains(prefab))
                return; // grew up
            var pos = zdo.GetPosition();
            var by = new List<string>();
            if (zdo.GetInt(ZDOVars.s_attackers) > 0)
                foreach (var peer in ZNet.instance.GetPeers())
                    if (!string.IsNullOrEmpty(peer.m_playerName) && zdo.GetBool(ZDOVars.s_attackers + peer.m_playerName))
                        by.Add(peer.m_playerName);
            var (near, dist) = NearestHostile(zdo, pos);

            var sb = new StringBuilder("{\"e\":\"petdeath\"");
            sb.Append(",\"p\":").Append(Json(zdo.GetString(ZDOVars.s_tamedName)));
            sb.Append(",\"i\":").Append(Json(prefab)).Append(",\"n\":1");
            sb.Append(",\"k\":").Append(Json(Key(zdo, prefab)));
            sb.Append($",\"x\":{Mathf.RoundToInt(pos.x)},\"z\":{Mathf.RoundToInt(pos.z)},\"hp\":{Mathf.RoundToInt(health)}");
            sb.Append(",\"lv\":").Append(Mathf.Max(zdo.GetInt(ZDOVars.s_level, 1) - 1, 0));
            sb.Append(",\"by\":[").Append(string.Join(",", by.ConvertAll(Json))).Append(']');
            if (near != null)
                sb.Append(",\"near\":").Append(Json(near)).Append($",\"nd\":{Mathf.RoundToInt(dist)}");
            Events.Emit(sb.Append('}').ToString());
        }

        // The closest untamed creature: one pass over all objects the server holds (~600k), fine for a rare event.
        private static (string, float) NearestHostile(ZDO dead, Vector3 pos)
        {
            var all = Traverse.Create(ZDOMan.instance).Field("m_objectsByID").GetValue<Dictionary<ZDOID, ZDO>>();
            ZDO best = null;
            var bestDist = NearRange;
            foreach (var zdo in all.Values)
            {
                var prefab = zdo.GetPrefab();
                if (zdo == dead || prefab == PlayerHash || !Combat.IsCharacter(prefab))
                    continue;
                var d = Vector3.Distance(zdo.GetPosition(), pos);
                if (d < bestDist && !zdo.GetBool(ZDOVars.s_tamed) && zdo.GetFloat(ZDOVars.s_health, 1f) > 0f)
                {
                    best = zdo;
                    bestDist = d;
                }
            }
            if (best == null)
                return (null, 0f);
            var level = best.GetInt(ZDOVars.s_level, 1);
            return (level > 1 ? $"{Gather.PrefabName(best)}*{level - 1}" : Gather.PrefabName(best), bestDist);
        }

        private static string Json(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var c in s ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append($"\\u{(int)c:x4}");
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }
}
