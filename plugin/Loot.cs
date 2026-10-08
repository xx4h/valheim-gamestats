// Logs who took what out of world containers (dungeon, treasure and shipwreck
// chests — anything without a creator), for the gamestats collector.
//
// Opening a container hands its ownership to the opener, and the owner sends
// every change to the server through ZDO.Deserialize: compare the container's
// items before and after, and credit what left it to the owner. Only items
// nobody has held yet count (ItemData.m_pickedUp, set by Player.OnInventoryChanged
// the first time an item enters any inventory) — the chest's own loot, not
// what a player stashed there and took back. Logged like the gather events:
//   [Gamestats] {"e":"loot","p":"Ragnar","i":"Coins","n":53}
using System.Collections.Generic;
using HarmonyLib;

namespace ValheimGamestats
{
    internal static class Loot
    {
        private static HashSet<int> _containers;

        private static bool IsContainer(int prefab)
        {
            if (_containers == null)
            {
                if (ZNetScene.instance == null)
                    return false;
                _containers = new HashSet<int>();
                foreach (var go in ZNetScene.instance.m_prefabs)
                    if (go != null && go.GetComponent<Container>() != null)
                        _containers.Add(go.name.GetStableHashCode());
            }
            return _containers.Contains(prefab);
        }

        // A world container's items nobody has held yet: prefab hash -> units; null if not tracked.
        internal static Dictionary<int, int> Unclaimed(ZDO zdo)
        {
            if (!IsContainer(zdo.GetPrefab()) || zdo.GetLong(ZDOVars.s_creator, 0L) != 0L)
                return null;
            var out_ = new Dictionary<int, int>();
            var bytes = zdo.GetByteArray(ZDOVars.s_items);
            if (bytes == null || bytes.Length < 4)
                return out_;
            var pkg = new ZPackage(bytes);
            var version = (Version.Item)pkg.ReadInt();
            if (version < Version.Item.Smaller)
                return out_;
            int n = pkg.ReadUShort();
            for (var k = 0; k < n; k++)
            {
                var (prefab, item) = ItemDrop.ItemData.Load(pkg, version);
                if (prefab == 0 || item.m_pickedUp || item.m_crafterID != 0L)
                    continue;
                out_.TryGetValue(prefab, out var have);
                out_[prefab] = have + item.m_stack;
            }
            return out_;
        }

        internal static void OnUpdate(ZDO zdo, Dictionary<int, int> before)
        {
            var after = Unclaimed(zdo);
            if (after == null)
                return;
            ZNetPeer peer = null;
            foreach (var kv in before)
            {
                after.TryGetValue(kv.Key, out var left);
                if (kv.Value <= left)
                    continue;
                peer = peer ?? ZNet.instance.GetPeer(zdo.GetOwner());
                if (peer == null)
                    return;
                var name = ObjectDB.instance?.GetItemPrefab(kv.Key)?.name;
                if (name != null)
                    Gather.Add("loot", peer.m_playerName, name, kv.Value - left);
            }
        }
    }

    [HarmonyPatch(typeof(ZDO), nameof(ZDO.Deserialize))]
    internal static class LootDeserializePatch
    {
        private static void Prefix(ZDO __instance, out Dictionary<int, int> __state)
        {
            __state = null;
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            try
            {
                __state = Loot.Unclaimed(__instance);
            }
            catch (System.Exception e)
            {
                Events.Warn("loot", e.Message);
            }
        }

        private static void Postfix(ZDO __instance, Dictionary<int, int> __state)
        {
            if (__state == null || __state.Count == 0)
                return;
            try
            {
                Loot.OnUpdate(__instance, __state);
            }
            catch (System.Exception e)
            {
                Events.Warn("loot", e.Message);
            }
        }
    }
}
