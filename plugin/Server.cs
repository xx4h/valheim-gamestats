// Who joined, died and left, restarts, raids, sleep, and a sample of the server once a minute — everything the
// collector used to read from the game's own log, as events in the plugin's store (Events.cs), so it needs nothing
// from the server log. New events: they go to the store only.
//   {"e":"start","p":"","i":"<world>","n":1,"game":"l-1.0.16","backend":"PlayFab"}  the world is up (Plugin.cs records
//                                                                       "plugin" at load); backend: PlayFab (crossplay) or Steamworks
//   {"e":"lobby","p":"","i":"active","n":1,"code":"017990"}              the PlayFab session is joinable (crossplay); "failed" with
//                                                                       "msg": PlayFab said no — players can't join until a restart
//   {"e":"stop","p":"","i":"","n":1}                                     a clean shutdown; a crash leaves none
//   {"e":"login","p":"Ragnar","i":"Steam_7656…","n":1,"uid":…}            a connection's first character, with its platform id
//   {"e":"spawn","p":"Ragnar","i":"","n":1,"uid":…}                       every character, respawns too
//   {"e":"death","p":"Ragnar","i":"","n":1,"uid":…,"x":…,"z":…}          the character is gone (the game's "… : 0:0")
//   {"e":"logout","p":"Ragnar","i":"","n":1,"uid":…}                      disconnected
//   {"e":"raid","p":"","i":"army_eikthyr","n":1,"x":…,"z":…,"near":[…]}  a raid started, and who was within its range
//   {"e":"raidend","p":"","i":"army_eikthyr","n":1}
//   {"e":"sleep","p":"","i":"","n":1,"time":…,"to":…}                   everyone slept: world time now, the morning it skips to
//   {"e":"server","p":"","i":"","n":<connections>,"zdos":…,"time":…}    once a minute: world objects, world time (s)
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Server
    {
        private static readonly HashSet<long> Playing = new HashSet<long>();  // connections that have had a character
        private static bool _started;

        internal static bool IsServer => ZNet.instance != null && ZNet.instance.IsServer();

        // every second: the world is loaded once ZoneSystem is there
        internal static void Tick()
        {
            if (_started || !IsServer || ZoneSystem.instance == null || string.IsNullOrEmpty(ZNet.instance.GetWorldName()))
                return;
            _started = true;
            // the plugin before 1.16.0 had another name (and GUID): BepInEx loads both, every event would count twice
            foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies())
                if (asm.GetName().Name == "GamestatsEquipment")
                    Events.Warn("copies", "GamestatsEquipment.dll is loaded too: every event counts twice — remove it from BepInEx/plugins and restart");
            var sb = new StringBuilder("{\"e\":\"start\",\"p\":\"\",\"i\":");
            Gather.Json(sb, ZNet.instance.GetWorldName()).Append(",\"n\":1,\"game\":");
            Gather.Json(sb, Version.GetVersionString()).Append(",\"backend\":");
            Gather.Json(sb, ZNet.m_onlineBackend.ToString()).Append('}');
            Events.Emit(sb.ToString(), log: false);
        }

        // once a minute, with the gather lines
        internal static void Sample()
        {
            if (!IsServer || ZDOMan.instance == null)
                return;
            Events.Emit($"{{\"e\":\"server\",\"p\":\"\",\"i\":\"\",\"n\":{ZNet.instance.GetPeers().Count},\"zdos\":{ZDOMan.instance.NrOfObjects()}," +
                        $"\"time\":{Num(ZNet.instance.GetTimeSeconds())}}}", log: false);
        }

        internal static void Stop()
        {
            if (!IsServer)
                return;
            Events.Emit("{\"e\":\"stop\",\"p\":\"\",\"i\":\"\",\"n\":1}", log: false);
        }

        internal static void Player(string e, ZNetPeer peer, string id = "", Vector3? at = null)
        {
            if (string.IsNullOrEmpty(peer.m_playerName))
                return;
            var sb = new StringBuilder("{\"e\":\"").Append(e).Append("\",\"p\":");
            Gather.Json(sb, peer.m_playerName).Append(",\"i\":");
            Gather.Json(sb, id).Append(",\"n\":1,\"uid\":").Append(peer.m_uid);
            if (at.HasValue)
                sb.Append(",\"x\":").Append(Mathf.RoundToInt(at.Value.x)).Append(",\"z\":").Append(Mathf.RoundToInt(at.Value.z));
            Events.Emit(sb.Append('}').ToString(), log: false);
        }

        internal static void OnCharacter(ZNetPeer peer, ZDOID before, ZDOID now)
        {
            if (now.IsNone())
            {
                if (before.IsNone())
                    return;
                // where it died: the character's last synced position, else the connection's reference point
                var zdo = ZDOMan.instance?.GetZDO(before);
                Player("death", peer, at: zdo != null ? zdo.GetPosition() : peer.m_refPos);
                return;
            }
            if (Playing.Add(peer.m_uid))
                Player("login", peer, PlatformId(peer));
            Player("spawn", peer);
        }

        internal static void OnDisconnect(ZNetPeer peer)
        {
            if (Playing.Remove(peer.m_uid))
                Player("logout", peer);
        }

        private static string PlatformId(ZNetPeer peer)
        {
            try
            {
                return peer.m_socket?.GetHostName() ?? "";
            }
            catch (System.Exception)
            {
                return "";
            }
        }

        internal static void OnRaid(string name, Vector3 pos, float range)
        {
            var sb = new StringBuilder("{\"e\":\"raid\",\"p\":\"\",\"i\":");
            Gather.Json(sb, name).Append(",\"n\":1,\"x\":").Append(Mathf.RoundToInt(pos.x)).Append(",\"z\":").Append(Mathf.RoundToInt(pos.z))
                .Append(",\"near\":[");
            var first = true;
            foreach (var peer in ZNet.instance.GetPeers())
            {
                if (string.IsNullOrEmpty(peer.m_playerName) || Utils.DistanceXZ(peer.m_refPos, pos) > range)
                    continue;
                Gather.Json(first ? sb : sb.Append(','), peer.m_playerName);
                first = false;
            }
            Events.Emit(sb.Append("]}").ToString(), log: false);
        }

        internal static void OnRaidEnd(string name)
        {
            var sb = new StringBuilder("{\"e\":\"raidend\",\"p\":\"\",\"i\":");
            Events.Emit(Gather.Json(sb, name).Append(",\"n\":1}").ToString(), log: false);
        }

        internal static void OnLobby(string state, string msg = null)
        {
            var sb = new StringBuilder("{\"e\":\"lobby\",\"p\":\"\",\"i\":");
            Gather.Json(sb, state).Append(",\"n\":1,\"code\":");
            Gather.Json(sb, ZPlayFabMatchmaking.JoinCode ?? "");
            if (msg != null)
                Gather.Json(sb.Append(",\"msg\":"), msg);
            Events.Emit(sb.Append('}').ToString(), log: false);
        }

        internal static void OnSleep(double time, double to) =>
            Events.Emit($"{{\"e\":\"sleep\",\"p\":\"\",\"i\":\"\",\"n\":1,\"time\":{Num(time)},\"to\":{Num(to)}}}", log: false);

        private static string Num(double v) => System.Math.Round(v, 1).ToString(CultureInfo.InvariantCulture);
    }

    [HarmonyPatch(typeof(ZNet), "RPC_CharacterID")]
    internal static class CharacterIdPatch
    {
        private static void Prefix(ZRpc rpc, out (ZNetPeer peer, ZDOID before) __state)
        {
            __state = (null, ZDOID.None);
            if (!Server.IsServer)
                return;
            foreach (var peer in ZNet.instance.GetPeers())
                if (peer.m_rpc == rpc)
                    __state = (peer, peer.m_characterID);
        }

        private static void Postfix(ZDOID characterID, (ZNetPeer peer, ZDOID before) __state)
        {
            if (__state.peer == null)
                return;
            try
            {
                Server.OnCharacter(__state.peer, __state.before, characterID);
            }
            catch (System.Exception e)
            {
                Events.Warn("server", e.Message);
            }
        }
    }

    [HarmonyPatch(typeof(ZNet), nameof(ZNet.Disconnect))]
    internal static class DisconnectPatch
    {
        private static void Prefix(ZNetPeer peer)
        {
            if (!Server.IsServer || peer == null)
                return;
            try
            {
                Server.OnDisconnect(peer);
            }
            catch (System.Exception e)
            {
                Events.Warn("server", e.Message);
            }
        }
    }

    // the last minute's sums and a stop event before the world goes away
    [HarmonyPatch(typeof(ZNet), nameof(ZNet.Shutdown), typeof(bool))]
    internal static class ShutdownPatch
    {
        private static void Prefix() => Plugin.Instance?.Stopping();
    }

    [HarmonyPatch(typeof(ZNet), nameof(ZNet.ShutdownWithoutSave))]
    internal static class ShutdownWithoutSavePatch
    {
        private static void Prefix() => Plugin.Instance?.Stopping();
    }

    [HarmonyPatch(typeof(RandEventSystem), "SetRandomEvent")]
    internal static class RandomEventPatch
    {
        // on the server only ever called to start or end one: whatever ran before is over
        private static void Prefix(RandomEvent ___m_randomEvent)
        {
            if (Server.IsServer && ___m_randomEvent != null)
                Server.OnRaidEnd(___m_randomEvent.m_name);
        }

        private static void Postfix(RandomEvent ev, Vector3 pos)
        {
            if (!Server.IsServer || ev == null)
                return;
            try
            {
                Server.OnRaid(ev.m_name, pos, ev.m_eventRange);
            }
            catch (System.Exception e)
            {
                Events.Warn("server", e.Message);
            }
        }
    }

    [HarmonyPatch(typeof(EnvMan), nameof(EnvMan.SkipToMorning))]
    internal static class SleepPatch
    {
        private static void Postfix(double ___m_skipToTime)
        {
            if (Server.IsServer)
                Server.OnSleep(ZNet.instance.GetTimeSeconds(), ___m_skipToTime);
        }
    }

    // The crossplay session (Valheim's ZPlayFabMatchmaking): the server registers a PlayFab lobby with a join code,
    // checks the code is unique, then activates the lobby — only an active one can be joined. On 2026-10-07 the check
    // got a lobby without owner back and threw (NullReferenceException in OnCheckJoinCodeSuccess): the session never
    // activated, nobody could join, the server ran on. These say whether it got there; health.py alerts "unjoinable".
    [HarmonyPatch(typeof(ZPlayFabMatchmaking), "OnActivateLobbySuccess")]
    internal static class LobbyActivePatch
    {
        private static void Postfix() => Server.OnLobby("active");
    }

    [HarmonyPatch(typeof(ZPlayFabMatchmaking), "OnFailed")]
    internal static class LobbyFailedPatch
    {
        private static void Postfix(string what) => Server.OnLobby("failed", what);
    }

    // reports the exception, changes nothing: the game's own handling stays as it is
    [HarmonyPatch(typeof(ZPlayFabMatchmaking), "OnCheckJoinCodeSuccess")]
    internal static class JoinCodeCheckPatch
    {
        private static System.Exception Finalizer(System.Exception __exception)
        {
            if (__exception != null)
                Events.Warn("lobby", "join-code check failed, the session won't activate: " + __exception.GetType().Name + ": " + __exception.Message);
            return __exception;
        }
    }
}
