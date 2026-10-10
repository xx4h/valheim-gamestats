// Adds the RCON command `equipment` to ValheimRcon: the visible equipment of
// every connected player, as one line of JSON for the gamestats collector —
// and since 1.9.0 how they look ("look": body model, skin and hair colour,
// hair and beard item), for the figure on their gear page.
//
// Only what the game already syncs to the server so other players can see it
// (VisEquipment ZDO vars): item prefab per slot, quality for hand/back items
// and the cape, style variant where the game has one. Inventory, food and
// crafter names never reach a dedicated server.
//
// Gather.cs logs who picked up, felled and mined what, Loot.cs what they took
// out of world chests, Custody.cs where gear goes, Dungeons.cs who went into
// which dungeon, Vitals.cs body & movement (see there).
//
// Terrain.cs samples the world once per seed for the map's terrain (see there).
//
// Also adds `tombstones`: the levelled, equippable items in every tombstone.
// The game never syncs the quality of armor, utility or trinket to the server,
// but a tombstone holds the dead player's whole inventory with exact levels —
// the collector uses it as "level at last death" for the worn item.
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using BepInEx;
using HarmonyLib;
using UnityEngine;
using ValheimRcon;
using ValheimRcon.Commands;

namespace ValheimGamestats
{
    [BepInPlugin(Guid, "Valheim Gamestats", Version)]
    [BepInDependency(ValheimRcon.Plugin.Guid)]
    public class Plugin : BaseUnityPlugin
    {
        public const string Guid = "valheim.gamestats";
        public const string Version = "1.22.1";
        internal static bool Diag;  // [Gamestats-diag] lines, off unless the config says so
        internal static Plugin Instance;
        private bool _stopped;

        private void Awake()
        {
            Instance = this;
            Diag = Config.Bind("Debug", "Diag", false, "Diagnostic lines in the server log ([Gamestats-diag])").Value;
            Events.LogToo = Config.Bind("Debug", "EventsToLog", false, "Every event in the server log too ([Gamestats] {…}), as before 1.18.0").Value;
            CombatTrace.Enabled = Config.Bind("Debug", "Trace", false,
                "Record what the combat logic sees to BepInEx/gamestats/trace/ (for replaying a session in tests; a few MB per session)").Value;
            Events.Init(Paths.BepInExRootPath);
            CombatTrace.Warn = msg => Events.Warn("trace", msg);
            CombatTrace.Fact = body => Events.Emit(body, log: false); // the combat facts, for the collector's rules
            CombatTrace.Init(Paths.BepInExRootPath);
            RconCommandsUtil.RegisterAllCommands(Assembly.GetExecutingAssembly());
            // one class at a time: a game update that breaks one hook disables that hook, not the plugin (and says so)
            var harmony = new Harmony(Guid);
            var hooks = 0;
            var failed = new List<string>();
            foreach (var type in AccessTools.GetTypesFromAssembly(Assembly.GetExecutingAssembly()))
            {
                if (type.GetCustomAttributes(typeof(HarmonyPatch), true).Length == 0)
                    continue;
                hooks++;
                try
                {
                    harmony.CreateClassProcessor(type).Patch();
                }
                catch (System.Exception e)
                {
                    failed.Add(type.Name);
                    Events.Warn("patch", type.Name + ": " + (e.InnerException ?? e).Message);
                }
            }
            InvokeRepeating(nameof(FlushGather), 60f, 60f);
            InvokeRepeating(nameof(SettleKills), 1f, 1f);
            InvokeRepeating(nameof(TerrainTick), 30f, 30f);  // once the world is loaded: sample it for the map (Terrain.cs)
            InvokeRepeating(nameof(DungeonTick), 2f, 2f);  // who is inside a dungeon (Dungeons.cs)
            InvokeRepeating(nameof(VitalsTick), 1f, 1f);  // body & movement of everyone online (Vitals.cs)
            // the collector dates its boss fights by this: from 1.5.0 damage is split by who attacked (fights.py); since
            // 1.19.0 with the hooks it applied ("hooks" of "of", "failed": their names) for its health check
            var start = new StringBuilder("{\"e\":\"plugin\",\"p\":\"\",\"i\":\"").Append(Version).Append("\",\"n\":1,\"hooks\":")
                .Append(hooks - failed.Count).Append(",\"of\":").Append(hooks).Append(",\"failed\":[");
            for (var i = 0; i < failed.Count; i++)
                Gather.Json(i > 0 ? start.Append(',') : start, failed[i]);
            Events.Emit(start.Append("]}").ToString(), log: true);
        }

        private void SettleKills() => Combat.Tick();

        private void TerrainTick() => Terrain.Tick();

        private void DungeonTick() => Dungeons.Tick();

        private void VitalsTick()
        {
            Vitals.Tick();
            Server.Tick();
        }

        private void FlushGather()
        {
            Gather.Flush();
            Vitals.Flush();
            Pets.Flush();
            Server.Sample();
        }

        // ZNet shuts down (Server.cs): the last minute's sums, then the stop event — before the world goes away
        internal void Stopping()
        {
            if (_stopped)
                return;
            _stopped = true;
            FlushGather();
            Server.Stop();
        }

        private void OnDestroy()
        {
            if (!_stopped)
                FlushGather();
            Events.Close();
        }
    }

    internal class Equipment : RconCommand
    {
        public override string Command => "equipment";
        public override string Description => "Visible equipment of all online players as JSON";

        // slot name, item var, quality var (0 = none), variant var (0 = none)
        private static readonly (string, int, int, int)[] Slots =
        {
            ("right", ZDOVars.s_rightItem, ZDOVars.s_rightItemQuality, 0),
            ("left", ZDOVars.s_leftItem, ZDOVars.s_leftItemQuality, ZDOVars.s_leftItemVariant),
            ("rightBack", ZDOVars.s_rightBackItem, ZDOVars.s_rightBackItemQuality, 0),
            ("leftBack", ZDOVars.s_leftBackItem, ZDOVars.s_leftBackItemQuality, ZDOVars.s_leftBackItemVariant),
            ("helmet", ZDOVars.s_helmetItem, 0, 0),
            ("chest", ZDOVars.s_chestItem, 0, 0),
            ("legs", ZDOVars.s_legItem, 0, 0),
            ("shoulder", ZDOVars.s_shoulderItem, ZDOVars.s_shoulderItemQuality, ZDOVars.s_shoulderItemVariant),
            ("utility", ZDOVars.s_utilityItem, 0, 0),
            ("trinket", ZDOVars.s_trinketItem, 0, 0),
        };

        protected override string OnHandle(CommandArgs args)
        {
            var sb = new StringBuilder("[");
            var first = true;
            foreach (var peer in ZNet.instance.GetPeers())
            {
                var zdo = ZDOMan.instance.GetZDO(peer.m_characterID);
                if (zdo == null || string.IsNullOrEmpty(peer.m_playerName))
                    continue;  // connected, character not spawned yet
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":").Append(Str(peer.m_playerName)).Append(",\"slots\":{");
                var firstSlot = true;
                foreach (var (slot, itemVar, qualityVar, variantVar) in Slots)
                {
                    var hash = zdo.GetInt(itemVar);
                    if (hash == 0) continue;
                    var prefab = ObjectDB.instance ? ObjectDB.instance.GetItemPrefab(hash) : null;
                    if (!firstSlot) sb.Append(',');
                    firstSlot = false;
                    sb.Append(Str(slot)).Append(":{\"item\":").Append(prefab ? Str(prefab.name) : hash.ToString());
                    if (qualityVar != 0) sb.Append(",\"q\":").Append(zdo.GetInt(qualityVar, 1));
                    if (variantVar != 0 && zdo.GetInt(variantVar) != 0) sb.Append(",\"v\":").Append(zdo.GetInt(variantVar));
                    sb.Append('}');
                }
                sb.Append('}');
                // how they look (VisEquipment): body model, skin and hair colour (the shader's tint), hair and beard item
                var skin = zdo.GetVec3(ZDOVars.s_skinColor, Vector3.one);
                var hair = zdo.GetVec3(ZDOVars.s_hairColor, Vector3.one);
                sb.Append(",\"look\":{\"m\":").Append(zdo.GetInt(ZDOVars.s_modelIndex));
                sb.Append(",\"skin\":").Append(Vec(skin)).Append(",\"hair\":").Append(Vec(hair));
                AppendItem(sb, "h", zdo.GetInt(ZDOVars.s_hairItem));
                AppendItem(sb, "b", zdo.GetInt(ZDOVars.s_beardItem));
                sb.Append("}}");
            }
            return sb.Append(']').ToString();
        }

        private static string Vec(Vector3 v) =>
            "[" + string.Join(",", new[] { v.x, v.y, v.z }.Select((f) => f.ToString("0.###", CultureInfo.InvariantCulture))) + "]";

        private static void AppendItem(StringBuilder sb, string key, int hash)
        {
            if (hash == 0) return;
            var prefab = ObjectDB.instance ? ObjectDB.instance.GetItemPrefab(hash) : null;
            sb.Append(",\"").Append(key).Append("\":").Append(prefab ? Str(prefab.name) : Str(hash.ToString()));
        }

        internal static string Str(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }

    internal class Tombstones : RconCommand
    {
        public override string Command => "tombstones";
        public override string Description => "Levelled equippable items in every tombstone, as JSON";

        private const int MaxReply = 3800;  // ValheimRcon truncates replies at ~4 KB
        private static readonly HashSet<ItemDrop.ItemData.ItemType> Equippable = new HashSet<ItemDrop.ItemData.ItemType>
        {
            ItemDrop.ItemData.ItemType.Helmet, ItemDrop.ItemData.ItemType.Chest, ItemDrop.ItemData.ItemType.Legs,
            ItemDrop.ItemData.ItemType.Shoulder, ItemDrop.ItemData.ItemType.Utility, ItemDrop.ItemData.ItemType.Trinket,
            ItemDrop.ItemData.ItemType.OneHandedWeapon, ItemDrop.ItemData.ItemType.TwoHandedWeapon,
            ItemDrop.ItemData.ItemType.TwoHandedWeaponLeft, ItemDrop.ItemData.ItemType.Bow, ItemDrop.ItemData.ItemType.Shield,
            ItemDrop.ItemData.ItemType.Torch, ItemDrop.ItemData.ItemType.Tool, ItemDrop.ItemData.ItemType.Attach_Atgeir,
        };

        protected override string OnHandle(CommandArgs args)
        {
            var zdos = new List<ZDO>();
            var index = 0;
            while (!ZDOMan.instance.GetAllZDOsWithPrefabIterative("Player_tombstone", zdos, ref index)) { }
            zdos.Sort((a, b) => b.GetLong(ZDOVars.s_timeOfDeath).CompareTo(a.GetLong(ZDOVars.s_timeOfDeath)));  // newest first

            var sb = new StringBuilder("[");
            foreach (var zdo in zdos)
            {
                var entry = Entry(zdo);
                if (entry == null) continue;
                if (sb.Length + entry.Length + 2 > MaxReply) break;  // drop the oldest rather than truncate the JSON
                if (sb.Length > 1) sb.Append(',');
                sb.Append(entry);
            }
            return sb.Append(']').ToString();
        }

        private static string Entry(ZDO zdo)
        {
            var data = zdo.GetByteArray(ZDOVars.s_items);
            var owner = zdo.GetString(ZDOVars.s_ownerName);
            if (data == null || data.Length == 0 || string.IsNullOrEmpty(owner)) return null;
            var pkg = new ZPackage(data);
            var version = (Version.Item)pkg.ReadInt();
            if (version < Version.Item.Smaller) return null;
            var sb = new StringBuilder();
            var count = pkg.ReadUShort();
            for (var i = 0; i < count; i++)
            {
                var (hash, item) = ItemDrop.ItemData.Load(pkg, version);
                var prefab = ObjectDB.instance ? ObjectDB.instance.GetItemPrefab(hash) : null;
                var shared = prefab ? prefab.GetComponent<ItemDrop>()?.m_itemData?.m_shared : null;
                if (shared == null || shared.m_maxQuality <= 1 || !Equippable.Contains(shared.m_itemType)) continue;
                if (sb.Length > 0) sb.Append(',');
                sb.Append("{\"item\":").Append(Equipment.Str(prefab.name)).Append(",\"q\":").Append(item.m_quality).Append('}');
            }
            if (sb.Length == 0) return null;
            return "{\"id\":\"" + zdo.m_uid + "\",\"owner\":" + Equipment.Str(owner)
                + ",\"died\":" + (zdo.GetLong(ZDOVars.s_timeOfDeath) / 10000000L) + ",\"items\":[" + sb + "]}";
        }
    }
}
