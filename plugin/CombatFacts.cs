// What the server can see of a fight beyond what CombatCore uses today: written to the combat trace (Debug / Trace),
// and handed to CombatCore as the inputs its attribution rules take (docs/ATTRIBUTION.md).
//   meta      once: creature prefabs whose death leaves no ragdoll; attacks that cost health (blood magic)
//   trig      every animation trigger of any character (players, creatures, summons, tames): who, which, follows whom
//   hit       a hit the server routes or receives (RPC_Damage): attacker, damage per type before resistances, hit type,
//             status effect, skill level, item level. A client's hits on creatures it runs itself never pass the server
//   killnote  the game's own kill note to a player (RPC_RegisterKill): from which client, which kind, boss, attackers
//   rise      a creature's health went up (regeneration, healing)
//   pethp     a tamed creature or summon lost health
//   owner     a character's owner client changed
//   drop      an item object appeared (loot of a death, or anything dropped)
// None of it changes what is recorded: Replay ignores these kinds.
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class CombatFacts
    {
        private static readonly int DamageHash = "RPC_Damage".GetStableHashCode();
        private static readonly int RegisterKillHash = "RPC_RegisterKill".GetStableHashCode();
        private static readonly int SetTriggerHash = "SetTrigger".GetStableHashCode();
        private static readonly Dictionary<ZDOID, long> Owners = new Dictionary<ZDOID, long>();
        private static readonly HashSet<ZDOID> SeenDrops = new HashSet<ZDOID>();
        private static HashSet<int> _items;
        private static bool _meta;

        // Once the prefabs are known: what a death leaves (per creature: the ragdolls its death spawns, none for the
        // corpse-less; several creatures can share one — Combat names a shared one after the first creature only), its
        // loot table, whether it's deleted on a timer; what an attack costs; how far a creature's attacks reach.
        // For CombatCore always, for the trace when it's on.
        internal static CombatMeta Meta(IEnumerable<GameObject> prefabs)
        {
            var meta = new CombatMeta();
            _items = new HashSet<int>();
            var noRagdoll = new List<string>();
            foreach (var go in prefabs)
            {
                if (go == null)
                    continue;
                var character = go.GetComponent<Character>();
                if (character != null && go.GetComponent<Player>() == null)
                {
                    meta.Names[go.name] = character.m_name; // what the game's kill notes name it by
                    var any = false;
                    foreach (var effect in character.m_deathEffects.m_effectPrefabs)
                    {
                        if (effect.m_prefab == null || effect.m_prefab.GetComponent<Ragdoll>() == null)
                            continue;
                        any = true;
                        if (!meta.Ragdolls.TryGetValue(effect.m_prefab.name, out var kinds))
                            meta.Ragdolls[effect.m_prefab.name] = kinds = new List<string>();
                        if (!kinds.Contains(go.name))
                            kinds.Add(go.name);
                    }
                    if (!any)
                        noRagdoll.Add(go.name);
                    var table = go.GetComponent<CharacterDrop>()?.m_drops;
                    if (table != null && table.Count > 0)
                    {
                        var items = new Dictionary<string, float>();
                        foreach (var drop in table)
                            if (drop.m_prefab != null)
                                items[drop.m_prefab.name] = Mathf.Max(drop.m_chance, items.TryGetValue(drop.m_prefab.name, out var c) ? c : 0f);
                        meta.Drops[go.name] = items;
                    }
                    if (go.GetComponent<CharacterTimedDestruction>() != null)
                        meta.Timed.Add(go.name);
                    if (character is Humanoid humanoid)
                        foreach (var item in Weapons(humanoid))
                            foreach (var attack in new[] { item.m_attack, item.m_secondaryAttack })
                                if (attack != null && !string.IsNullOrEmpty(attack.m_attackAnimation))
                                {
                                    var key = go.name + "/" + attack.m_attackAnimation;
                                    meta.Reach[key] = Mathf.Max(item.m_aiAttackRange, meta.Reach.TryGetValue(key, out var r) ? r : 0f);
                                }
                }
                var shared = go.GetComponent<ItemDrop>()?.m_itemData.m_shared;
                if (shared == null)
                    continue;
                _items.Add(go.name.GetStableHashCode());
                if (shared.m_attack != null && !string.IsNullOrEmpty(shared.m_attack.m_attackAnimation))
                {
                    // a player weapon: projectile or melee (and how far it reaches), and whether it does damage at all —
                    // a shield or summoning cast is no evidence for a kill
                    var ranged = false;
                    var reach = 0f;
                    foreach (var attack in new[] { shared.m_attack, shared.m_secondaryAttack })
                        if (attack != null)
                        {
                            ranged |= attack.m_attackType == Attack.AttackType.Projectile;
                            reach = Mathf.Max(reach, attack.m_attackRange);
                        }
                    meta.Weapons[go.name] = (ranged, reach, shared.m_damages.GetTotalDamage() > 0f);
                }
                foreach (var attack in new[] { shared.m_attack, shared.m_secondaryAttack })
                    if (attack != null && (attack.m_attackHealth > 0f || attack.m_attackHealthPercentage > 0f))
                        meta.Costs[go.name + "/" + attack.m_attackAnimation] = (attack.m_attackHealth, attack.m_attackHealthPercentage);
            }
            meta.NoRagdoll.UnionWith(noRagdoll);
            if (CombatTrace.Enabled && !_meta)
                CombatTrace.Meta(noRagdoll, meta);
            _meta = true;
            return meta;
        }

        // Every weapon a creature can carry: its default items, random weapons and sets.
        private static IEnumerable<ItemDrop.ItemData.SharedData> Weapons(Humanoid h)
        {
            var all = new List<GameObject>();
            all.AddRange(h.m_defaultItems ?? new GameObject[0]);
            all.AddRange(h.m_randomWeapon ?? new GameObject[0]);
            if (h.m_randomSets != null)
                foreach (var set in h.m_randomSets)
                    all.AddRange(set.m_items ?? new GameObject[0]);
            foreach (var go in all)
            {
                var shared = go != null ? go.GetComponent<ItemDrop>()?.m_itemData.m_shared : null;
                if (shared != null)
                    yield return shared;
            }
        }

        // ---- routed calls: hits and kill notes are addressed to one client, the server routes or handles them ------

        internal static void OnRpc(ZRoutedRpc.RoutedRPCData data)
        {
            if (data.m_targetPeerID == 0L)
                return; // neither is ever sent to everybody; those pass both hooks
            if (data.m_methodHash == DamageHash)
                OnHit(data);
            else if (data.m_methodHash == RegisterKillHash)
                OnKillNote(data);
        }

        private static void OnHit(ZRoutedRpc.RoutedRPCData data)
        {
            var target = ZDOMan.instance.GetZDO(data.m_targetZDO);
            if (target == null || !Combat.IsCharacter(target.GetPrefab()))
                return; // buildings, trees, rocks
            var hit = new HitData();
            var pkg = data.m_parameters;
            var start = pkg.GetPos();
            try
            {
                hit.Deserialize(ref pkg);
            }
            finally
            {
                pkg.SetPos(start);
            }
            var who = Who(hit.m_attacker);
            if (who != null && who.StartsWith("player:"))
                Combat.Core.Hit(Time.time, Uid(target), who.Substring(7), hit.m_damage.GetTotalDamage());
            else if (!hit.m_attacker.IsNone() && ZDOMan.instance.GetZDO(hit.m_attacker) is ZDO summon && summon.GetBool(ZDOVars.s_tamed)
                     && Follow(summon) is string follow)
                Combat.Core.SummonHit(Time.time, Uid(target), follow, Gather.PrefabName(summon), hit.m_damage.GetTotalDamage(), Variant(summon));
            if (!CombatTrace.Enabled)
                return;
            var se = hit.m_statusEffectHash == 0 ? null : ObjectDB.instance?.GetStatusEffect(hit.m_statusEffectHash)?.name ?? hit.m_statusEffectHash.ToString();
            CombatTrace.Hit(Time.time, Uid(target), Who(target), target.GetBool(ZDOVars.s_tamed), target.GetOwner(),
                PeerName(data.m_senderPeerID), hit.m_attacker.IsNone() ? null : hit.m_attacker.ToString(), who,
                Damages(hit.m_damage), hit.m_hitType.ToString(), se, hit.m_skill.ToString(), hit.m_skillLevel, hit.m_itemLevel,
                hit.m_backstabBonus, Vec(hit.m_point));
        }

        private static void OnKillNote(ZRoutedRpc.RoutedRPCData data)
        {
            var pkg = data.m_parameters;
            var start = pkg.GetPos();
            try
            {
                var kind = pkg.ReadString();
                var boss = pkg.ReadInt();
                pkg.ReadInt(); // modifiers
                var attackers = pkg.ReadInt();
                var to = ZNet.instance.GetPeer(data.m_targetPeerID)?.m_playerName;
                Combat.Core.KillNote(Time.time, data.m_senderPeerID, to, kind);
                if (CombatTrace.Enabled)
                    CombatTrace.KillNote(Time.time, PeerName(data.m_senderPeerID), PeerName(data.m_targetPeerID), kind, boss, attackers,
                        data.m_senderPeerID);
            }
            finally
            {
                pkg.SetPos(start);
            }
        }

        // Every animation trigger reaches the server (sent to everybody): creatures' and summons' attacks too.
        internal static void OnTrigger(ZRoutedRpc.RoutedRPCData data)
        {
            if (data.m_methodHash != SetTriggerHash || data.m_targetZDO.IsNone())
                return;
            var zdo = ZDOMan.instance.GetZDO(data.m_targetZDO);
            if (zdo == null || !Combat.IsCharacter(zdo.GetPrefab()) || (!CombatTrace.Enabled && !zdo.GetBool(ZDOVars.s_tamed)))
                return;
            var pkg = data.m_parameters;
            var start = pkg.GetPos();
            string trigger;
            try
            {
                trigger = pkg.ReadString();
            }
            finally
            {
                pkg.SetPos(start);
            }
            var follow = Follow(zdo);
            var tamed = zdo.GetBool(ZDOVars.s_tamed);
            if (CombatTrace.Enabled)
                CombatTrace.Trigger(Time.time, Uid(zdo), Who(zdo), trigger, follow, tamed, zdo.GetOwner(), Vec(zdo.GetPosition()),
                    ItemName(zdo.GetInt(ZDOVars.s_rightItem)), ItemName(zdo.GetInt(ZDOVars.s_leftItem)));
            if (tamed && follow != null)
                Combat.Core.Summon(Time.time, Uid(zdo), Gather.PrefabName(zdo), trigger, follow, Vec(zdo.GetPosition()), Variant(zdo));
        }

        // ---- world state ---------------------------------------------------------------------------------------------

        // A character's state arrived: owner changes, and its health going up (drops are CombatCore's; a pet's here).
        internal static void OnCharacter(ZDO zdo, float before, bool player)
        {
            if (!CombatTrace.Enabled)
                return;
            var owner = zdo.GetOwner();
            if (Owners.TryGetValue(zdo.m_uid, out var had) && had != owner)
                CombatTrace.Owner(Time.time, Uid(zdo), Who(zdo), had, owner);
            if (Owners.Count > 5000)
                Owners.Clear();
            Owners[zdo.m_uid] = owner;
            if (player)
                return; // regeneration and food: every second, nothing combat needs
            var after = zdo.GetFloat(ZDOVars.s_health, before);
            var tamed = zdo.GetBool(ZDOVars.s_tamed);
            if (after > before + 0.01f)
                CombatTrace.Rise(Time.time, Uid(zdo), Who(zdo), tamed, before, after);
            else if (tamed && before - after > 0.01f)
                CombatTrace.PetHealth(Time.time, Uid(zdo), Who(zdo), Follow(zdo), before, after);
        }

        // Any other object's state arrived: a new item object is loot (or something dropped).
        internal static void OnObject(ZDO zdo)
        {
            if (_items == null || !_items.Contains(zdo.GetPrefab()) || !SeenDrops.Add(zdo.m_uid))
                return;
            if (SeenDrops.Count > 5000)
                SeenDrops.Clear();
            if (CombatTrace.Enabled)
                CombatTrace.Drop(Time.time, Uid(zdo), Gather.PrefabName(zdo), zdo.GetInt(ZDOVars.s_stack, 1), zdo.GetOwner(), Vec(zdo.GetPosition()));
            Combat.Core.Loot(Time.time, Uid(zdo), Gather.PrefabName(zdo), (long)zdo.m_uid.UserID, Vec(zdo.GetPosition()));
        }

        internal static void Forget(ZDO zdo) => Owners.Remove(zdo.m_uid);

        // ---- helpers -------------------------------------------------------------------------------------------------

        internal static string Follow(ZDO zdo)
        {
            var follow = zdo.GetString(ZDOVars.s_follow);
            return string.IsNullOrEmpty(follow) ? null : follow;
        }

        internal static string PeerName(long id)
        {
            if (id == ZDOMan.GetSessionID())
                return "server";
            var name = ZNet.instance.GetPeer(id)?.m_playerName;
            return string.IsNullOrEmpty(name) ? id.ToString() : name;
        }

        private static string Uid(ZDO zdo) => zdo.m_uid.ToString();

        // A summon's variant: what it holds, right hand + left hand ("skeleton_sword2+ShieldWood"), null if nothing.
        internal static string Variant(ZDO zdo)
        {
            var right = ItemName(zdo.GetInt(ZDOVars.s_rightItem));
            var left = ItemName(zdo.GetInt(ZDOVars.s_leftItem));
            return right == null ? left : left == null ? right : right + "+" + left;
        }

        // What a character holds (synced like a player's): which variant a summon is (bow, sword, sword + shield).
        private static string ItemName(int hash) => hash == 0 ? null : ZNetScene.instance.GetPrefab(hash)?.name ?? hash.ToString();

        // A player's character: their name; anything else: its prefab with stars (Troll*1).
        private static string Who(ZDOID id)
        {
            if (id.IsNone())
                return null;
            var zdo = ZDOMan.instance.GetZDO(id);
            return zdo == null ? "?" : Who(zdo);
        }

        private static string Who(ZDO zdo)
        {
            foreach (var peer in ZNet.instance.GetPeers())
                if (peer.m_characterID == zdo.m_uid)
                    return "player:" + peer.m_playerName;
            var prefab = Gather.PrefabName(zdo);
            var level = zdo.GetInt(ZDOVars.s_level, 1);
            return level > 1 ? $"{prefab}*{level - 1}" : prefab;
        }

        private static List<(string, float)> Damages(HitData.DamageTypes d)
        {
            var list = new List<(string, float)>();
            void Put(string type, float value)
            {
                if (value != 0f)
                    list.Add((type, value));
            }
            Put("damage", d.m_damage);
            Put("blunt", d.m_blunt);
            Put("slash", d.m_slash);
            Put("pierce", d.m_pierce);
            Put("chop", d.m_chop);
            Put("pickaxe", d.m_pickaxe);
            Put("fire", d.m_fire);
            Put("frost", d.m_frost);
            Put("lightning", d.m_lightning);
            Put("poison", d.m_poison);
            Put("spirit", d.m_spirit);
            return list;
        }

        private static Vec Vec(Vector3 v) => new Vec(v.x, v.y, v.z);
    }

    // Hits and kill notes for a client pass the server only on their way (ZRoutedRpc.RPC_RoutedRPC: not for the server,
    // so never HandleRoutedRPC). Those addressed to the server itself come through HandleRoutedRpcPatch (Attacks.cs).
    [HarmonyPatch(typeof(ZRoutedRpc), "RouteRPC")]
    internal static class RouteRpcPatch
    {
        private static void Prefix(ZRoutedRpc.RoutedRPCData rpcData)
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            try
            {
                CombatFacts.OnRpc(rpcData);
            }
            catch (System.Exception e)
            {
                Events.Warn("trace", e.Message);
            }
        }
    }
}
