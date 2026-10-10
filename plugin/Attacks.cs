// Who attacked when, and with what — so Combat.cs can split a creature's
// health drop over the players who actually swung or shot, not evenly over
// everyone who ever hit it.
//
// Every attack starts with an animation trigger on the attacker's character
// (Attack.Start → ZSyncAnimation.SetTrigger), a routed RPC to everybody that
// the server handles too: the trigger is the weapon's attack animation, plus a
// digit for combo steps and random variants ("swing_longsword2"). It is matched
// against the attack animations of what the player holds (synced equipment), so
// interact / eat / equip / emote triggers never count. Bare fists match the
// Player prefab's unarmed weapon. The trigger fires when the swing starts or
// the arrow is released; the hit lands up to a few seconds later.
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Attacks
    {
        private static readonly int SetTriggerHash = "SetTrigger".GetStableHashCode();
        private static ItemDrop _unarmed;
        private static readonly HashSet<string> Seen = new HashSet<string>();

        private static string Name(int hash) => hash == 0 ? "-" : ZNetScene.instance.GetPrefab(hash)?.name ?? hash.ToString();

        internal static void OnTrigger(ZRoutedRpc.RoutedRPCData data)
        {
            if (data.m_methodHash != SetTriggerHash || data.m_targetZDO.IsNone())
                return;
            var peer = ZNet.instance.GetPeer(data.m_senderPeerID);
            if (peer == null || peer.m_characterID != data.m_targetZDO)
                return; // a client animating a creature it owns, not its own character
            var zdo = ZDOMan.instance.GetZDO(data.m_targetZDO);
            if (zdo == null)
                return;
            var start = data.m_parameters.GetPos();
            string trigger;
            try
            {
                trigger = data.m_parameters.ReadString();
            }
            finally
            {
                data.m_parameters.SetPos(start);
            }
            var weapon = AttackWeapon(zdo, trigger) ?? AttackWeapon(zdo, trigger.TrimEnd('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'));
            // DIAG (temporary): each trigger / held-items pair once, to check the matching on the live server.
            var held = $"{Name(zdo.GetInt(ZDOVars.s_leftItem))}/{Name(zdo.GetInt(ZDOVars.s_rightItem))}";
            if (Plugin.Diag && Seen.Count < 500 && Seen.Add(trigger + " " + held))
                ZLog.Log($"[Gamestats-diag] trigger {trigger} held={held} -> {weapon ?? "no attack"}");
            if (weapon == null)
                return;
            var now = Time.time;
            if (CombatTrace.Enabled)
                CombatTrace.Attack(now, peer.m_playerName, weapon);
            Combat.Core.Attack(now, peer.m_playerName, weapon, trigger);
        }

        // The held item whose primary or secondary attack starts with this animation, "Unarmed" for fists, else null.
        private static string AttackWeapon(ZDO zdo, string animation)
        {
            if (animation.Length == 0)
                return null;
            foreach (var hash in new[] { zdo.GetInt(ZDOVars.s_leftItem), zdo.GetInt(ZDOVars.s_rightItem) })
            {
                var prefab = hash == 0 ? null : ZNetScene.instance.GetPrefab(hash);
                var shared = prefab?.GetComponent<ItemDrop>()?.m_itemData.m_shared;
                if (shared != null && (shared.m_attack?.m_attackAnimation == animation || shared.m_secondaryAttack?.m_attackAnimation == animation))
                    return prefab.name;
            }
            if (_unarmed == null)
                _unarmed = ZNetScene.instance.GetPrefab("Player")?.GetComponent<Humanoid>()?.m_unarmedWeapon;
            var fists = _unarmed?.m_itemData.m_shared;
            if (fists != null && (fists.m_attack?.m_attackAnimation == animation || fists.m_secondaryAttack?.m_attackAnimation == animation))
                return "Unarmed";
            return null;
        }

        // Attacks by this player in [from, to], oldest first (the history is CombatCore's).
        internal static IEnumerable<string> Between(string player, float from, float to) => Combat.Core.Between(player, from, to);
    }

    [HarmonyPatch(typeof(ZRoutedRpc), "HandleRoutedRPC")]
    internal static class HandleRoutedRpcPatch
    {
        private static void Prefix(ZRoutedRpc.RoutedRPCData data)
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            try
            {
                Attacks.OnTrigger(data);
                CombatFacts.OnTrigger(data);
                if (data.m_targetPeerID == ZDOMan.GetSessionID())
                    CombatFacts.OnRpc(data); // a hit on a creature the server runs; the rest pass RouteRpcPatch
            }
            catch (System.Exception e)
            {
                Events.Warn("attacks", e.Message);
            }
        }
    }
}
