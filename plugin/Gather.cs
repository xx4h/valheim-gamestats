// Logs who picked up, felled and mined what, for the gamestats collector.
//
// Clients run hits and picks on objects they own locally, so those often
// never reach the server. Every deletion does: the deleting client reports it
// ("DestroyZDO", with its peer id) while the server still holds the object.
//
// - pick: an ItemDrop deleted by a client standing ≤8 m from it. Picking up
//   takes ownership first (ItemDrop.RequestOwn), so the deleting client is
//   the picker; despawns happen with nobody near. Auto-stack merges (only
//   with >200 loose items on one client) would count too. Only first
//   pickups (since 1.11.0): an item that has been in an inventory before
//   (ItemData.m_pickedUp — dropped by a player, crafted) is not new.
// - fell / mine: a standing tree (TreeBase) or a rock / ore deposit
//   (MineRock, MineRock5) deleted. The deleting client is merely the area's
//   owner, so the nearest player within 15 m gets the credit.
//
// Kills and damage come from Combat.cs, loot from world chests from Loot.cs.
// Everything is summed per minute and logged as one line per (event, player,
// object), e.g.
//   [Gamestats] {"e":"pick","p":"Ragnar","i":"Wood","n":37}
using System.Collections.Generic;
using System.Text;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Gather
    {
        private const float PickRange = 8f;
        private const float CreditRange = 15f;

        private static readonly Dictionary<(string e, string p, string i), double> Counts =
            new Dictionary<(string, string, string), double>();

        internal static string PrefabName(ZDO zdo) =>
            ZNetScene.instance?.GetPrefab(zdo.GetPrefab())?.name ?? zdo.GetPrefab().ToString();

        internal static void OnDestroyed(long sender, ZDO zdo)
        {
            var prefab = ZNetScene.instance?.GetPrefab(zdo.GetPrefab());
            if (prefab == null)
                return;
            var pos = zdo.GetPosition();
            // DIAG: the server deletes some objects itself; only creatures matter there (a dead mob it owned)
            if (sender == ZDOMan.GetSessionID())
            {
                if (prefab.GetComponent<Character>() != null)
                    Combat.OnDestroyed(zdo, prefab, sender);
                return;
            }
            if (prefab.GetComponent<ItemDrop>() != null)
            {
                if (zdo.GetBool(ZDOVars.s_piece))
                    return;
                var peer = ZNet.instance.GetPeer(sender);
                if (peer == null || Distance(peer, pos) > PickRange)
                    return;
                var item = new ItemDrop.ItemData();
                ItemDrop.LoadFromZDO(item, zdo);
                if (Custody.IsTracked(zdo.GetPrefab()))  // gear: every pickup, for "who has it" (Custody.cs)
                    Custody.Log("carry", peer.m_playerName, (zdo.GetPrefab(), item.m_crafterName ?? "", item.m_quality), "ground", pos, 1);
                if (!item.m_pickedUp)
                    Add("pick", peer.m_playerName, prefab.name, Mathf.Max(1, zdo.GetInt(ZDOVars.s_stack, 1)));
            }
            else if (prefab.GetComponent<TreeBase>() != null)
            {
                Credit("fell", prefab.name, pos);
            }
            else if (prefab.GetComponent<MineRock5>() != null || prefab.GetComponent<MineRock>() != null)
            {
                Credit("mine", prefab.name, pos);
            }
            else if (prefab.GetComponent<Character>() != null)
            {
                Combat.OnDestroyed(zdo, prefab, sender);
            }
        }

        internal static float Distance(ZNetPeer peer, Vector3 pos)
        {
            var character = ZDOMan.instance.GetZDO(peer.m_characterID);
            return character == null ? float.MaxValue : Vector3.Distance(character.GetPosition(), pos);
        }

        private static void Credit(string e, string what, Vector3 pos)
        {
            var best = NearestPeer(pos, CreditRange);
            if (best != null)
                Add(e, best.m_playerName, what, 1);
        }

        internal static ZNetPeer NearestPeer(Vector3 pos, float range)
        {
            ZNetPeer best = null;
            var bestDistance = range;
            foreach (var peer in ZNet.instance.GetPeers())
            {
                var d = Distance(peer, pos);
                if (d <= bestDistance)
                {
                    best = peer;
                    bestDistance = d;
                }
            }
            return best;
        }

        internal static void Add(string e, string p, string i, double n)
        {
            if (string.IsNullOrEmpty(p) && e != "ukill" && e != "udmg") // a kill / damage nobody could be credited with: no player by nature
                return;
            p ??= "";
            Counts.TryGetValue((e, p, i), out var have);
            Counts[(e, p, i)] = have + n;
        }

        internal static void Flush()
        {
            foreach (var kv in Counts)
            {
                if (System.Math.Round(kv.Value) < 1)
                    continue;
                var sb = new StringBuilder("{\"e\":");
                Json(sb, kv.Key.e).Append(",\"p\":");
                Json(sb, kv.Key.p).Append(",\"i\":");
                Json(sb, kv.Key.i).Append(",\"n\":").Append(System.Math.Round(kv.Value)).Append('}');
                Events.Emit(sb.ToString());
            }
            Counts.Clear();
        }

        internal static StringBuilder Json(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                if (c == '"' || c == '\\')
                    sb.Append('\\').Append(c);
                else if (c < ' ')
                    sb.Append("\\u").Append(((int)c).ToString("x4"));
                else
                    sb.Append(c);
            }
            return sb.Append('"');
        }
    }

    [HarmonyPatch(typeof(ZDOMan), "RPC_DestroyZDO")]
    internal static class DestroyZdoPatch
    {
        // Read the ids before the game handles (and forgets) the ZDOs; rewind
        // so the original method reads the package from the start.
        private static void Prefix(long sender, ZPackage pkg)
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            var start = pkg.GetPos();
            try
            {
                var n = pkg.ReadInt();
                for (var k = 0; k < n; k++)
                {
                    var zdo = ZDOMan.instance.GetZDO(pkg.ReadZDOID());
                    if (zdo != null)
                        Gather.OnDestroyed(sender, zdo);
                }
            }
            catch (System.Exception e)
            {
                Events.Warn("gather", e.Message);
            }
            finally
            {
                pkg.SetPos(start);
            }
        }
    }
}
