// Logs where gear goes, for the gamestats collector: who took a weapon, tool
// or piece of armor out of a chest or off a stand, and who put it (back) in.
// A player's inventory never reaches the server, but every way an item leaves
// a shared place does — so "taken by X, not put back since" is the answer to
// "who has the axe?". Copies are told apart by crafter and quality, the only
// identity an item has.
//
// - chests (any container: player-built, world chests, tombstones): the
//   opener owns the container while it is open and sends its new contents
//   through ZDO.Deserialize — the items it lost were taken, the ones it gained
//   put in, both by the owner. Fresh world loot nobody has held yet
//   (m_pickedUp false) appearing in a chest is not a "put".
// - item & armor stands: the stand's state changes the same way, but whoever
//   owns the stand may not be the one standing at it — the nearest player
//   within 8 m gets the credit.
// - ground: Gather.cs logs every pickup of such an item as "carry".
//
// Not summed: one line per move, with the place, e.g.
//   [Gamestats] {"e":"take","p":"Ragnar","i":"AxeBlackMetal","q":3,"c":"Astrid","k":"chest","x":120,"z":-460,"n":1}
using System.Collections.Generic;
using System.Text;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Custody
    {
        private const float StandRange = 8f;
        private const int ArmorSlots = 16;

        private enum Kind { None, Container, ItemStand, ArmorStand }

        private static Dictionary<int, Kind> _kinds;
        private static readonly Dictionary<int, bool> Tracked = new Dictionary<int, bool>();
        private static readonly int TombstoneHash = "Player_tombstone".GetStableHashCode();
        private static readonly int[] SlotItem = new int[ArmorSlots];

        static Custody()
        {
            for (var i = 0; i < ArmorSlots; i++)
                SlotItem[i] = (i + "_item").GetStableHashCode();
        }

        private static Kind KindOf(int prefab)
        {
            if (_kinds == null)
            {
                if (ZNetScene.instance == null)
                    return Kind.None;
                _kinds = new Dictionary<int, Kind>();
                foreach (var go in ZNetScene.instance.m_prefabs)
                {
                    if (go == null)
                        continue;
                    var kind = go.GetComponent<Container>() != null ? Kind.Container
                        : go.GetComponent<ItemStand>() != null ? Kind.ItemStand
                        : go.GetComponent<ArmorStand>() != null ? Kind.ArmorStand : Kind.None;
                    if (kind != Kind.None)
                        _kinds[go.name.GetStableHashCode()] = kind;
                }
            }
            return _kinds.TryGetValue(prefab, out var k) ? k : Kind.None;
        }

        // Gear worth following: equippable and unstackable (weapons, tools, armor, capes, utility, trinkets) — not torches.
        internal static bool IsTracked(int prefab)
        {
            if (Tracked.TryGetValue(prefab, out var yes))
                return yes;
            var shared = ObjectDB.instance?.GetItemPrefab(prefab)?.GetComponent<ItemDrop>()?.m_itemData?.m_shared;
            if (shared == null)
                return false; // ObjectDB not ready: ask again later
            switch (shared.m_itemType)
            {
                case ItemDrop.ItemData.ItemType.OneHandedWeapon:
                case ItemDrop.ItemData.ItemType.TwoHandedWeapon:
                case ItemDrop.ItemData.ItemType.TwoHandedWeaponLeft:
                case ItemDrop.ItemData.ItemType.Bow:
                case ItemDrop.ItemData.ItemType.Shield:
                case ItemDrop.ItemData.ItemType.Helmet:
                case ItemDrop.ItemData.ItemType.Chest:
                case ItemDrop.ItemData.ItemType.Legs:
                case ItemDrop.ItemData.ItemType.Hands:
                case ItemDrop.ItemData.ItemType.Shoulder:
                case ItemDrop.ItemData.ItemType.Utility:
                case ItemDrop.ItemData.ItemType.Tool:
                case ItemDrop.ItemData.ItemType.Attach_Atgeir:
                case ItemDrop.ItemData.ItemType.Trinket:
                    yes = shared.m_maxStackSize == 1;
                    break;
                default:
                    yes = false;
                    break;
            }
            return Tracked[prefab] = yes;
        }

        // Ships and carts are containers that send updates many times a second while they move:
        // keep the raw items to compare, parse only what changed.
        internal class State
        {
            public byte[] Items;
            public Dictionary<(int, string, int), (int n, bool held)> Stand;
        }

        internal static State Before(ZDO zdo)
        {
            var kind = KindOf(zdo.GetPrefab());
            if (kind == Kind.None)
                return null;
            return kind == Kind.Container ? new State { Items = zdo.GetByteArray(ZDOVars.s_items) ?? new byte[0] } : new State { Stand = Holds(zdo, kind, null) };
        }

        private static bool Same(byte[] a, byte[] b)
        {
            if (a.Length != b.Length)
                return false;
            for (var i = 0; i < a.Length; i++)
                if (a[i] != b[i])
                    return false;
            return true;
        }

        // What tracked gear a container (its items blob) or stand holds: (prefab, crafter, quality) -> (units, held before).
        private static Dictionary<(int, string, int), (int n, bool held)> Holds(ZDO zdo, Kind kind, byte[] bytes)
        {
            var out_ = new Dictionary<(int, string, int), (int, bool)>();
            void Add(int prefab, ItemDrop.ItemData item)
            {
                if (prefab == 0 || !IsTracked(prefab))
                    return;
                var key = (prefab, item.m_crafterName ?? "", item.m_quality);
                out_.TryGetValue(key, out var have);
                out_[key] = (have.Item1 + item.m_stack, have.Item2 || item.m_pickedUp);
            }
            if (kind == Kind.Container)
            {
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
                    Add(prefab, item);
                }
            }
            else if (kind == Kind.ItemStand)
            {
                var item = new ItemDrop.ItemData { m_quality = zdo.GetInt(ZDOVars.s_quality, 1), m_stack = 1 };
                ItemDrop.LoadFromZDO(item, zdo);
                item.m_stack = 1;
                item.m_pickedUp = true;
                Add(zdo.GetInt(ZDOVars.s_item), item);
            }
            else
            {
                for (var i = 0; i < ArmorSlots; i++)
                {
                    var prefab = zdo.GetInt(SlotItem[i]);
                    if (prefab == 0)
                        continue;
                    var item = new ItemDrop.ItemData { m_quality = 1, m_stack = 1 };
                    ItemDrop.LoadFromZDO(item, zdo, i);
                    item.m_stack = 1;
                    item.m_pickedUp = true;
                    Add(prefab, item);
                }
            }
            return out_;
        }

        internal static void OnUpdate(ZDO zdo, State state)
        {
            var kind = KindOf(zdo.GetPrefab());
            Dictionary<(int, string, int), (int n, bool held)> before, after;
            if (kind == Kind.Container)
            {
                var now = zdo.GetByteArray(ZDOVars.s_items) ?? new byte[0];
                if (Same(state.Items, now))
                    return;
                before = Holds(zdo, kind, state.Items);
                after = Holds(zdo, kind, now);
            }
            else
            {
                before = state.Stand;
                after = Holds(zdo, kind, null);
            }
            var where = kind == Kind.Container
                ? (zdo.GetPrefab() == TombstoneHash ? "tombstone" : zdo.GetLong(ZDOVars.s_creator, 0L) != 0L ? "chest" : "world chest")
                : "stand";
            ZNetPeer who = null;
            ZNetPeer Who()
            {
                if (who != null)
                    return who;
                var pos = zdo.GetPosition();
                var owner = ZNet.instance.GetPeer(zdo.GetOwner());
                if (kind == Kind.Container)
                    return who = owner;
                return who = owner != null && Gather.Distance(owner, pos) <= StandRange ? owner : Gather.NearestPeer(pos, StandRange);
            }
            foreach (var kv in before)
            {
                after.TryGetValue(kv.Key, out var now);
                if (kv.Value.n > now.n && Who() != null)
                    Log(kind == Kind.Container ? "take" : "off", Who().m_playerName, kv.Key, where, zdo.GetPosition(), kv.Value.n - now.n);
            }
            foreach (var kv in after)
            {
                before.TryGetValue(kv.Key, out var was);
                if (kv.Value.n > was.n && kv.Value.held && Who() != null)
                    Log(kind == Kind.Container ? "put" : "on", Who().m_playerName, kv.Key, where, zdo.GetPosition(), kv.Value.n - was.n);
            }
        }

        internal static void Log(string e, string player, (int prefab, string crafter, int quality) item, string where, Vector3 pos, int n)
        {
            var name = ObjectDB.instance?.GetItemPrefab(item.prefab)?.name;
            if (string.IsNullOrEmpty(player) || name == null)
                return;
            var sb = new StringBuilder("{\"e\":");
            Gather.Json(sb, e).Append(",\"p\":");
            Gather.Json(sb, player).Append(",\"i\":");
            Gather.Json(sb, name).Append(",\"q\":").Append(item.quality).Append(",\"c\":");
            Gather.Json(sb, item.crafter).Append(",\"k\":");
            Gather.Json(sb, where).Append(",\"x\":").Append(Mathf.RoundToInt(pos.x)).Append(",\"z\":").Append(Mathf.RoundToInt(pos.z))
                .Append(",\"n\":").Append(n).Append('}');
            Events.Emit(sb.ToString());
        }
    }

    [HarmonyPatch(typeof(ZDO), nameof(ZDO.Deserialize))]
    internal static class CustodyDeserializePatch
    {
        private static void Prefix(ZDO __instance, out Custody.State __state)
        {
            __state = null;
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            try
            {
                __state = Custody.Before(__instance);
            }
            catch (System.Exception e)
            {
                Events.Warn("custody", e.Message);
            }
        }

        private static void Postfix(ZDO __instance, Custody.State __state)
        {
            if (__state == null)
                return;
            try
            {
                Custody.OnUpdate(__instance, __state);
            }
            catch (System.Exception e)
            {
                Events.Warn("custody", e.Message);
            }
        }
    }
}
