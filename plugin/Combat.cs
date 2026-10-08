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
// - kill / wkill: a mob dies. Two signals, matched by place and time:
//   a mob deleted with health ≤ 0 (its attackers get the kill), and the
//   ragdoll every death spawns (a networked object, so it reaches the server
//   even when a one-hit kill is deleted before its last state is synced).
//   A ragdoll without a counted death is such a one-hit kill: the attackers
//   the server knows, else the nearest player within 15 m, get the kill and
//   the mob's last known health as damage. Names carry the stars: Troll*1.
// - Tamed creatures are not combat: hitting or butchering a pet is neither damage dealt
//   nor a kill (Pets.cs logs it instead). Their deaths are still recorded below, as
//   already counted, so their ragdoll isn't taken for a one-hit kill of the nearest player.
// - dw / kw: the same damage and kills per weapon and creature together,
//   object "Weapon>Creature" (e.g. MaceIron>Troll*1), for "what did this
//   weapon kill" and "what was this creature killed with".
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Combat
    {
        private const float MatchRange = 4f;
        private const float AttackerRange = 60f; // bow range, roughly
        private const float HitWindow = 3f; // swing starts → hit lands → its health sync arrives; arrows fly ~1-2 s
        private const float MatchSeconds = 6f;
        private const float SettleSeconds = 3f; // let the deletion of a ragdoll's mob arrive first

        private static HashSet<int> _characters;
        private static Dictionary<int, string> _ragdolls; // ragdoll prefab → creature prefab
        private static readonly int PlayerHash = "Player".GetStableHashCode();

        private class Death
        {
            public Vector3 Pos;
            public float Time;
            public string Name;
            public float Health;
            public List<string> Attackers;
            public bool Counted;
        }

        private class Corpse
        {
            public Vector3 Pos;
            public float Time;
            public string Creature;
            public int Level;
        }

        private static readonly List<Death> Deaths = new List<Death>();
        private static readonly List<Corpse> Corpses = new List<Corpse>();
        private static readonly HashSet<ZDOID> SeenCorpses = new HashSet<ZDOID>();
        private static readonly Dictionary<ZDOID, List<string>> Killers = new Dictionary<ZDOID, List<string>>(); // at health 0

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
            return true;
        }

        internal static bool IsCharacter(int prefab) => Init() && _characters.Contains(prefab);

        internal static void OnHealthChanged(ZDO zdo, float before, float maxBefore)
        {
            Pets.OnUpdate(zdo, before, maxBefore);
            if (zdo.GetBool(ZDOVars.s_tamed))
                return; // a pet: not combat
            var after = Mathf.Max(0f, zdo.GetFloat(ZDOVars.s_health, before));
            var lost = before - after;
            if (lost <= 0.01f)
                return;
            if (zdo.GetPrefab() == PlayerHash)
            {
                var maxAfter = zdo.GetFloat(ZDOVars.s_maxHealth, maxBefore);
                if (maxAfter < maxBefore - 0.01f && Mathf.Abs(after - maxAfter) < 0.01f)
                    return; // food wore off, health clamped to the new max
                var victim = PeerOf(zdo);
                if (victim == null)
                    return;
                Gather.Add("taken", victim.m_playerName, "", lost);
                Gather.Add("hit", victim.m_playerName, "", 1);
                Vitals.OnPlayerHit(victim.m_playerName, lost, after);
                return;
            }
            var attackers = Attackers(zdo);
            if (after <= 0f)
            {
                // The kill is counted when the mob is deleted, which can be seconds later: whoever was in the fight
                // now keeps the kill even if they die in between (a boss's last hit often takes someone with it).
                if (Killers.Count > 1000)
                    Killers.Clear();
                Killers[zdo.m_uid] = attackers;
            }
            if (after <= 0f)
                Diag("death-sync", zdo, Gather.PrefabName(zdo), 0, attackers, $"health {before:0.#}→{zdo.GetFloat(ZDOVars.s_health, before):0.#}");
            if (attackers.Count > 0)
                Damage(attackers, MobName(zdo, Gather.PrefabName(zdo)), lost, Time.time);
        }

        internal static void OnDestroyed(ZDO zdo, GameObject prefab, long sender)
        {
            Pets.OnDestroyed(zdo, prefab.name);
            if (zdo.GetPrefab() == PlayerHash)
                return;
            var death = new Death
            {
                Pos = zdo.GetPosition(),
                Time = Time.time,
                Name = MobName(zdo, prefab.name),
                Health = Mathf.Max(0f, zdo.GetFloat(ZDOVars.s_health, zdo.GetFloat(ZDOVars.s_maxHealth, 0f))),
                Attackers = Killers.TryGetValue(zdo.m_uid, out var killers) ? killers : Attackers(zdo),
            };
            Killers.Remove(zdo.m_uid);
            if (zdo.GetBool(ZDOVars.s_tamed))
            {
                death.Counted = true; // a pet: no kill, but its ragdoll must find this death
                Deaths.Add(death);
                return;
            }
            if (zdo.GetFloat(ZDOVars.s_health, 1f) <= 0f)
            {
                Kill(death.Attackers, death.Name, death.Time);
                death.Counted = true;
            }
            var server = sender == ZDOMan.GetSessionID();
            if (!death.Counted || server)
                Diag(death.Counted ? "destroy-server-kill" : "destroy-nokill", zdo, prefab.name, sender, death.Attackers,
                    $"health {zdo.GetFloat(ZDOVars.s_health, -1f):0.#} max {zdo.GetFloat(ZDOVars.s_maxHealth, -1f):0.#} attackersN {zdo.GetInt(ZDOVars.s_attackers)}");
            Deaths.Add(death);
        }

        // Every received ZDO update passes here; new ragdolls are deaths.
        internal static void OnUpdate(ZDO zdo)
        {
            if (!Init() || !_ragdolls.TryGetValue(zdo.GetPrefab(), out var creature) || !SeenCorpses.Add(zdo.m_uid))
                return;
            Corpses.Add(new Corpse { Pos = zdo.GetPosition(), Time = Time.time, Creature = creature, Level = zdo.GetInt(ZDOVars.s_level, 1) });
        }

        // Called every second: settle ragdolls against the deletions seen around them.
        internal static void Tick()
        {
            var now = Time.time;
            for (var k = Corpses.Count - 1; k >= 0; k--)
            {
                var corpse = Corpses[k];
                if (now - corpse.Time < SettleSeconds)
                    continue;
                Corpses.RemoveAt(k);
                Death match = null;
                foreach (var d in Deaths)
                    if (Mathf.Abs(d.Time - corpse.Time) <= MatchSeconds && Vector3.Distance(d.Pos, corpse.Pos) <= MatchRange
                        && (match == null || Vector3.Distance(d.Pos, corpse.Pos) < Vector3.Distance(match.Pos, corpse.Pos)))
                        match = d;
                if (match == null)
                    Diag("ragdoll-nomatch", null, corpse.Creature, 0, null, $"level {corpse.Level} at {corpse.Pos.x:0},{corpse.Pos.z:0}", corpse.Pos);
                if (match != null && match.Counted)
                    continue; // already a kill via its health
                var name = corpse.Level > 1 ? $"{corpse.Creature}*{corpse.Level - 1}" : corpse.Creature;
                var attackers = match?.Attackers.Count > 0 ? match.Attackers : Nearest(corpse.Pos);
                if (attackers.Count == 0)
                    continue;
                Kill(attackers, match?.Name ?? name, match?.Time ?? corpse.Time);
                if (match != null && match.Health > 0f)
                    Damage(attackers, match.Name, match.Health, match.Time); // the one-hit kill's damage never synced
                if (match != null)
                    match.Counted = true;
            }
            Deaths.RemoveAll(d => now - d.Time > 2 * MatchSeconds + SettleSeconds);
            if (Corpses.Count == 0 && SeenCorpses.Count > 1000)
                SeenCorpses.Clear();
        }

        private static void Damage(List<string> attackers, string mob, float amount, float at)
        {
            var hits = new List<(string Player, string Weapon)>();
            foreach (var p in attackers)
                foreach (var weapon in Attacks.Between(p, at - HitWindow, at))
                    hits.Add((p, weapon));
            if (hits.Count == 0)
                foreach (var p in attackers)
                    hits.Add((p, WeaponOf(p, at)));
            foreach (var (p, weapon) in hits)
            {
                Gather.Add("dmg", p, mob, amount / hits.Count);
                Gather.Add("wdmg", p, weapon, amount / hits.Count);
                Gather.Add("dw", p, $"{weapon}>{mob}", amount / hits.Count);
            }
        }

        private static void Kill(List<string> attackers, string mob, float at)
        {
            foreach (var p in attackers)
            {
                var weapon = WeaponOf(p, at);
                Gather.Add("kill", p, mob, 1);
                Gather.Add("wkill", p, weapon, 1);
                Gather.Add("kw", p, $"{weapon}>{mob}", 1);
            }
        }

        // DIAG (temporary): one line per suspicious creature event, only with a player within 30 m. Not picked up by
        // the collector (its filter wants "[Gamestats] {"); read with kubectl logs | grep Gamestats-diag.
        private static void Diag(string what, ZDO zdo, string name, long sender, List<string> attackers, string detail, Vector3? at = null)
        {
            if (!Plugin.Diag)
                return;
            var pos = at ?? zdo.GetPosition();
            var near = Gather.NearestPeer(pos, 30f);
            if (near == null)
                return;
            var from = sender == 0 ? "-" : sender == ZDOMan.GetSessionID() ? "server" : ZNet.instance.GetPeer(sender)?.m_playerName ?? sender.ToString();
            var dist = Vector3.Distance(ZDOMan.instance.GetZDO(near.m_characterID)?.GetPosition() ?? pos, pos);
            ZLog.Log($"[Gamestats-diag] {what} {name} {detail} attackers=[{string.Join(",", attackers ?? new List<string>())}] from={from} nearest={near.m_playerName}@{dist:0.#}m owner={(zdo == null ? "-" : zdo.GetOwner().ToString())}");
        }

        private static string MobName(ZDO zdo, string prefab)
        {
            var level = zdo.GetInt(ZDOVars.s_level, 1);
            return level > 1 ? $"{prefab}*{level - 1}" : prefab;
        }

        private static List<string> Attackers(ZDO zdo)
        {
            var names = new List<string>();
            if (zdo.GetInt(ZDOVars.s_attackers) == 0)
                return names;
            var pos = zdo.GetPosition();
            foreach (var peer in ZNet.instance.GetPeers())
            {
                if (string.IsNullOrEmpty(peer.m_playerName) || !zdo.GetBool(ZDOVars.s_attackers + peer.m_playerName))
                    continue;
                var character = ZDOMan.instance.GetZDO(peer.m_characterID); // none while dead / respawning
                if (character == null || character.GetBool(ZDOVars.s_dead) || Vector3.Distance(character.GetPosition(), pos) > AttackerRange)
                    continue;
                names.Add(peer.m_playerName);
            }
            return names;
        }

        private static List<string> Nearest(Vector3 pos)
        {
            var names = new List<string>();
            var peer = Gather.NearestPeer(pos, 15f);
            if (peer != null)
                names.Add(peer.m_playerName);
            return names;
        }

        // The weapon of their last attack, else what they hold — hands are empty while eating, switching or sheathed.
        private static string WeaponOf(string player, float at) => Attacks.Last(player, at) ?? HeldWeapon(player);

        // What they hold: bows and other left-hand weapons, else the right hand.
        private static string HeldWeapon(string player)
        {
            foreach (var peer in ZNet.instance.GetPeers())
            {
                if (peer.m_playerName != player)
                    continue;
                var zdo = ZDOMan.instance.GetZDO(peer.m_characterID);
                if (zdo == null)
                    break;
                var left = ItemPrefab(zdo.GetInt(ZDOVars.s_leftItem));
                var type = left?.GetComponent<ItemDrop>()?.m_itemData.m_shared.m_itemType;
                if (type == ItemDrop.ItemData.ItemType.Bow || type == ItemDrop.ItemData.ItemType.TwoHandedWeaponLeft)
                    return left.name;
                var right = ItemPrefab(zdo.GetInt(ZDOVars.s_rightItem));
                if (right != null)
                    return right.name;
                break;
            }
            return "Unarmed";
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
                    Combat.OnHealthChanged(__instance, __state.health, __state.max);
                else
                    Combat.OnUpdate(__instance);
            }
            catch (System.Exception e)
            {
                Events.Warn("combat", e.Message);
            }
        }
    }
}
