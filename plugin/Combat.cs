// Kills, damage dealt and damage / hits taken, for the gamestats collector.
//
// Hits often never reach the server as events (an owner applies them
// locally), but their effect does: health is synced state (ZDOVars.s_health),
// and every player who hits a mob is written into the mob's state too
// (ZDOVars.s_attackers + name, set in Character.RPC_Damage). So:
//
// - dmg / wdmg: a mob's health drops in an update the server receives —
//   credited to the online players in its attacker list who attacked in the
//   HitWindow before it (Attacks.cs: their swings and shots), one share per
//   attack, with that attack's weapon. Nobody did (damage over time, a missed
//   trigger): split evenly, each with the weapon of their last attack, else
//   what they hold. The game never takes anyone off the attacker list, so
//   only attackers alive and within AttackerRange count: someone who died or
//   left the fight would otherwise keep a share.
// - taken / hit: a player's health drops — the amount, and one hit per drop
//   (hits inside one sync interval merge; damage-over-time ticks count each).
//   A drop to exactly the new, lower max health is food wearing off: skipped.
//   A drop that is the cost of the player's own blood magic is `cost`, not damage.
// - kill / wkill: a mob dies. Two signals, matched by place and time:
//   a mob deleted with health ≤ 0 (its attackers get the kill), and the
//   ragdoll every death spawns (a networked object, so it reaches the server
//   even when a one-hit kill is deleted before its last state is synced).
//   A ragdoll (only matched to a death of a kind that spawns it) without a counted
//   death is such a one-hit kill: the attackers
//   the server knows get the kill and the mob's last known health as damage.
//   Names carry the stars: Troll*1. A death with nobody to credit is never
//   guessed from who is near: `ukill` (no player), and a log line to investigate.
//   Kinds without a ragdoll drop their loot at death instead: a deletion with
//   health left plus its own loot (drop table, same client, 3 m, 2 s) is a kill.
// - Tamed creatures are not combat: hitting or butchering a pet is neither damage dealt
//   nor a kill (Pets.cs logs it instead). Their deaths are still recorded below, as
//   already counted, so their ragdoll isn't taken for a one-hit kill of the nearest player.
// - dw / kw: the same damage and kills per weapon and creature together,
//   object "Weapon>Creature" (e.g. MaceIron>Troll*1), for "what did this
//   weapon kill" and "what was this creature killed with".
//
// These rules are CombatCore (no game types, tested in tests/plugin); this file only reads the game's state for it.
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    // The game side of CombatCore: reads the creatures', players' and attacker lists' state and hands it over as plain
    // values (and, with Trace on, to CombatTrace — what tests/plugin replays). The rules live in CombatCore.
    internal static class Combat
    {
        private static HashSet<int> _characters;
        private static Dictionary<int, string> _ragdolls; // ragdoll prefab → creature prefab
        internal static readonly int PlayerHash = "Player".GetStableHashCode();

        internal static readonly CombatCore Core = new CombatCore(Add, Diag);

        private static void Add(string e, string p, string i, double n)
        {
            Gather.Add(e, p, i, n);
            if (CombatTrace.Enabled && (!string.IsNullOrEmpty(p) || e == "ukill"))
                CombatTrace.Out(e, p ?? "", i, n);
        }

        private static bool Init()
        {
            if (_characters != null)
                return true;
            if (ZNetScene.instance == null)
                return false;
            _characters = new HashSet<int>();
            _ragdolls = new Dictionary<int, string>();
            foreach (var go in ZNetScene.instance.m_prefabs)
            {
                var character = go != null ? go.GetComponent<Character>() : null;
                if (character == null)
                    continue;
                _characters.Add(go.name.GetStableHashCode());
                if (go.GetComponent<Player>() != null)
                    continue;
                foreach (var effect in character.m_deathEffects.m_effectPrefabs)
                {
                    var prefab = effect.m_prefab;
                    if (prefab != null && prefab.GetComponent<Ragdoll>() != null && !_ragdolls.ContainsKey(prefab.name.GetStableHashCode()))
                        _ragdolls[prefab.name.GetStableHashCode()] = go.name;
                }
            }
            Core.Meta(CombatFacts.Meta(ZNetScene.instance.m_prefabs));
            return true;
        }

        internal static bool IsCharacter(int prefab) => Init() && _characters.Contains(prefab);

        internal static void OnHealthChanged(ZDO zdo, float before, float maxBefore)
        {
            Pets.OnUpdate(zdo, before, maxBefore);
            if (zdo.GetBool(ZDOVars.s_tamed))
                return; // a pet: not combat
            var after = zdo.GetFloat(ZDOVars.s_health, before);
            if (before - Mathf.Max(0f, after) <= 0.01f)
                return;
            if (zdo.GetPrefab() == PlayerHash)
            {
                var victim = PeerOf(zdo);
                if (victim == null)
                    return;
                var maxAfter = zdo.GetFloat(ZDOVars.s_maxHealth, maxBefore);
                if (CombatTrace.Enabled)
                    CombatTrace.Player(Time.time, victim.m_playerName, before, after, maxBefore, maxAfter);
                var taken = Core.PlayerHealth(victim.m_playerName, before, after, maxBefore, maxAfter, Time.time);
                if (taken > 0f)
                    Vitals.OnPlayerHit(victim.m_playerName, taken, Mathf.Max(0f, after));
                return;
            }
            var t = Time.time;
            var uid = zdo.m_uid.ToString();
            var mob = MobName(zdo, Gather.PrefabName(zdo));
            var pos = Vec(zdo.GetPosition());
            var onList = OnList(zdo);
            if (CombatTrace.Enabled)
                CombatTrace.Health(t, uid, mob, pos, before, after, onList);
            Core.CreatureHealth(t, uid, mob, pos, before, after, onList);
        }

        internal static void OnDestroyed(ZDO zdo, GameObject prefab, long sender)
        {
            Pets.OnDestroyed(zdo, prefab.name);
            if (zdo.GetPrefab() == PlayerHash)
                return;
            var t = Time.time;
            var uid = zdo.m_uid.ToString();
            var mob = MobName(zdo, prefab.name);
            var tamed = zdo.GetBool(ZDOVars.s_tamed);
            var pos = Vec(zdo.GetPosition());
            var health = zdo.GetFloat(ZDOVars.s_health, float.NaN);
            var max = zdo.GetFloat(ZDOVars.s_maxHealth, float.NaN);
            float? h = float.IsNaN(health) ? (float?)null : health, mh = float.IsNaN(max) ? (float?)null : max;
            var onList = OnList(zdo);
            var players = Players();
            var server = sender == ZDOMan.GetSessionID();
            if (CombatTrace.Enabled)
            {
                CombatTrace.Destroyed(t, uid, mob, tamed, pos, h, mh, onList, players, server, zdo.GetOwner(), CombatFacts.PeerName(sender),
                    CombatFacts.Follow(zdo));
                CombatFacts.Forget(zdo);
            }
            var from = sender == 0 ? "-" : server ? "server" : ZNet.instance.GetPeer(sender)?.m_playerName ?? sender.ToString();
            Core.Destroyed(t, uid, mob, tamed, pos, h, mh, onList, players, server,
                $"attackersN {zdo.GetInt(ZDOVars.s_attackers)} from={from} owner={zdo.GetOwner()}", zdo.GetOwner());
        }

        // Every received ZDO update passes here; new ragdolls are deaths.
        internal static void OnUpdate(ZDO zdo)
        {
            if (!Init() || !_ragdolls.TryGetValue(zdo.GetPrefab(), out var creature))
                return;
            var t = Time.time;
            var uid = zdo.m_uid.ToString();
            var level = zdo.GetInt(ZDOVars.s_level, 1);
            var pos = Vec(zdo.GetPosition());
            if (CombatTrace.Enabled)
                CombatTrace.Ragdoll(t, uid, creature, level, pos, Gather.PrefabName(zdo));
            Core.Ragdoll(t, uid, creature, level, pos, Gather.PrefabName(zdo));
        }

        // Called every second: settle ragdolls against the deletions seen around them.
        internal static void Tick()
        {
            if (ZNet.instance == null)
                return; // the world is still loading
            var t = Time.time;
            var players = Players();
            if (CombatTrace.Enabled)
                CombatTrace.Tick(t, players);
            Core.Tick(t, players);
        }

        // DIAG (temporary): one line per suspicious creature event, only with a player within 30 m. Not picked up by
        // the collector (its filter wants "[Gamestats] {"); read with kubectl logs | grep Gamestats-diag.
        private static void Diag(string what, string name, List<string> attackers, string detail, Vec? at)
        {
            if (what == "unaccounted")
            {
                // always: a kill nobody could be credited with, for investigation (docs/ATTRIBUTION.md, "Unaccounted kills")
                var where = at == null ? "" : $" at {at.Value.X:0},{at.Value.Z:0}";
                var nearest = at == null ? null : Gather.NearestPeer(new Vector3(at.Value.X, at.Value.Y, at.Value.Z), 60f);
                ZLog.Log($"[Gamestats-unaccounted] {name} {detail}{where} nearest player within 60 m: {nearest?.m_playerName ?? "none"}");
                return;
            }
            if (!Plugin.Diag || at == null)
                return;
            var pos = new Vector3(at.Value.X, at.Value.Y, at.Value.Z);
            var near = Gather.NearestPeer(pos, 30f);
            if (near == null)
                return;
            var dist = Vector3.Distance(ZDOMan.instance.GetZDO(near.m_characterID)?.GetPosition() ?? pos, pos);
            ZLog.Log($"[Gamestats-diag] {what} {name} {detail} attackers=[{string.Join(",", attackers ?? new List<string>())}] nearest={near.m_playerName}@{dist:0.#}m");
        }

        private static string MobName(ZDO zdo, string prefab)
        {
            var level = zdo.GetInt(ZDOVars.s_level, 1);
            return level > 1 ? $"{prefab}*{level - 1}" : prefab;
        }

        private static Vec Vec(Vector3 v) => new Vec(v.x, v.y, v.z);

        // Every online player: their character (none while dead or respawning), position, what they hold.
        private static List<PlayerState> Players()
        {
            var players = new List<PlayerState>();
            foreach (var peer in ZNet.instance.GetPeers())
                if (!string.IsNullOrEmpty(peer.m_playerName))
                    players.Add(State(peer));
            return players;
        }

        // The online players on a creature's attacker list (as the game wrote it, never cleared).
        private static List<PlayerState> OnList(ZDO zdo)
        {
            var players = new List<PlayerState>();
            if (zdo.GetInt(ZDOVars.s_attackers) == 0)
                return players;
            foreach (var peer in ZNet.instance.GetPeers())
                if (!string.IsNullOrEmpty(peer.m_playerName) && zdo.GetBool(ZDOVars.s_attackers + peer.m_playerName))
                    players.Add(State(peer));
            return players;
        }

        private static PlayerState State(ZNetPeer peer)
        {
            var character = ZDOMan.instance.GetZDO(peer.m_characterID); // none while dead / respawning
            return character == null
                ? new PlayerState(peer.m_playerName, false, false, default, null)
                : new PlayerState(peer.m_playerName, true, character.GetBool(ZDOVars.s_dead), Vec(character.GetPosition()), HeldWeapon(character));
        }

        // What they hold: bows and other left-hand weapons, else the right hand, else bare fists.
        private static string HeldWeapon(ZDO character)
        {
            var left = ItemPrefab(character.GetInt(ZDOVars.s_leftItem));
            var type = left?.GetComponent<ItemDrop>()?.m_itemData.m_shared.m_itemType;
            if (type == ItemDrop.ItemData.ItemType.Bow || type == ItemDrop.ItemData.ItemType.TwoHandedWeaponLeft)
                return left.name;
            var right = ItemPrefab(character.GetInt(ZDOVars.s_rightItem));
            return right != null ? right.name : "Unarmed";
        }

        private static GameObject ItemPrefab(int hash) => hash == 0 ? null : ZNetScene.instance.GetPrefab(hash);

        private static ZNetPeer PeerOf(ZDO zdo)
        {
            foreach (var peer in ZNet.instance.GetPeers())
                if (peer.m_characterID == zdo.m_uid)
                    return peer;
            return null;
        }
    }

    // Every state update the server receives goes through ZDO.Deserialize;
    // note health before, compare after — characters only, so it stays cheap.
    [HarmonyPatch(typeof(ZDO), nameof(ZDO.Deserialize))]
    internal static class ZdoDeserializePatch
    {
        private static void Prefix(ZDO __instance, out (bool track, float health, float max) __state)
        {
            __state = default;
            if (ZNet.instance == null || !ZNet.instance.IsServer() || !Combat.IsCharacter(__instance.GetPrefab()))
                return;
            var max = __instance.GetFloat(ZDOVars.s_maxHealth, 0f);
            __state = (true, __instance.GetFloat(ZDOVars.s_health, max), max);
        }

        private static void Postfix(ZDO __instance, (bool track, float health, float max) __state)
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            try
            {
                if (__state.track)
                {
                    CombatFacts.OnCharacter(__instance, __state.health, __instance.GetPrefab() == Combat.PlayerHash);
                    Combat.OnHealthChanged(__instance, __state.health, __state.max);
                }
                else
                {
                    Combat.OnUpdate(__instance);
                    CombatFacts.OnObject(__instance);
                }
            }
            catch (System.Exception e)
            {
                Events.Warn("combat", e.Message);
            }
        }
    }
}
