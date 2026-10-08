// Body & movement of every online player, for the gamestats collector — sampled once a second from what each client
// syncs to the server on its character (position, health, max health, stamina, eitr, in bed, emotes, crouching).
//
// Summed per minute with the gather lines (Gather.Add), e.g. [Gamestats] {"e":"dist","p":"Ragnar","i":"foot","n":412}:
//   dist  i=foot|swim|boat|ride  metres moved (portal jumps and dungeon interiors left out)
//   crouch                        seconds crouched (sneaking)
//   exh / exhn                    seconds at no stamina / times it ran out
//   emote i=<emote>               emotes played
//   bed                           times they lay down in a bed at night
// The highest value per minute (not summed), [Gamestats] {"e":"peak","p":"Ragnar","i":"hp","n":187}:
//   hp / st / eitr                health, stamina, eitr maxima — max health is synced, stamina and eitr peak when full
//   y                             highest point, metres above sea level
//   v_foot|v_swim|v_boat|v_ride   top speed in m/s (over a second)
//   hit                           biggest single hit taken and survived (from Combat's health watch)
// One line each, as it happens:
//   sprint     m, s   a run (faster than jogging, on foot) from start to stop, ≥ 5 s
//   closecall  hp, max  health fell below 10 % of max and came back above half without dying; hp is the lowest
//   fall       h      metres fallen in one go onto land, alive 5 s later
// Swimming and sailing are told apart by the water level (30 m) and the world's base terrain height below; riding by a
// saddled tamed creature right at the player.
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Vitals
    {
        private const float SprintSpeed = 5.2f;   // m/s: running (jogging is ~4)
        private const float Teleport = 40f;       // m/s: faster than anything but a portal
        private const float Interior = 3000f;     // dungeon interiors are built ~5000 m up
        private const float CloseCall = 0.1f, Recovered = 0.5f;
        private const float FallMin = 8f;
        private static readonly int Crouching = 438569 + ZSyncAnimation.GetHash("crouching");  // ZSyncAnimation keeps animator bools in the ZDO
        private static readonly HashSet<int> Mounts = new HashSet<int> { "Lox".GetStableHashCode(), "Asksvin".GetStableHashCode() };

        private class State
        {
            public ZDOID Character;
            public Vector3 Pos;
            public bool HasPos, Riding, Exhausted, InBed;
            public int EmoteId = -1, Tick;
            public float SprintM, SprintS;
            public float PeakY = float.NegativeInfinity, FallH;
            public bool Dropping;  // fell fast and mostly straight down since PeakY (not a run down a slope)
            public float FallAt = -1f;
            public float LowHp = float.PositiveInfinity, LowMax;
            public bool InDanger;
        }

        private static readonly Dictionary<long, State> States = new Dictionary<long, State>();
        private static readonly Dictionary<(string p, string k), float> Peaks = new Dictionary<(string, string), float>();
        private static readonly List<ZDO> Near = new List<ZDO>();

        private static void Peak(string p, string k, float v)
        {
            if (!Peaks.TryGetValue((p, k), out var have) || v > have)
                Peaks[(p, k)] = v;
        }

        // Combat sees every health drop of a player; the biggest one they lived through is a peak
        internal static void OnPlayerHit(string player, float lost, float after)
        {
            if (after > 0f)
                Peak(player, "hit", lost);
        }

        internal static void Tick()
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer() || ZoneSystem.instance == null)
                return;
            var seen = new HashSet<long>();
            foreach (var peer in ZNet.instance.GetPeers())
            {
                seen.Add(peer.m_uid);
                var zdo = ZDOMan.instance.GetZDO(peer.m_characterID);
                if (zdo == null)
                    continue;
                if (!States.TryGetValue(peer.m_uid, out var s) || s.Character != peer.m_characterID)
                {
                    // a new character (a respawn): a close call or a fall in progress ended in death — not one
                    States[peer.m_uid] = s = new State { Character = peer.m_characterID };
                }
                try
                {
                    Sample(peer.m_playerName, zdo, s);
                }
                catch (System.Exception e)
                {
                    Events.Warn("vitals", e.Message);
                }
            }
            var gone = new List<long>();
            foreach (var uid in States.Keys)
                if (!seen.Contains(uid))
                    gone.Add(uid);
            foreach (var uid in gone)
            {
                EndSprint(States[uid], null);
                States.Remove(uid);
            }
        }

        private static void Sample(string p, ZDO zdo, State s)
        {
            if (string.IsNullOrEmpty(p))
                return;
            s.Tick++;
            var pos = zdo.GetPosition();
            var water = ZoneSystem.instance.m_waterLevel;
            var hp = zdo.GetFloat(ZDOVars.s_health, 0f);
            var max = zdo.GetFloat(ZDOVars.s_maxHealth, 0f);
            var dead = zdo.GetBool(ZDOVars.s_dead) || hp <= 0f;

            // ---- body
            if (max > 0f)
                Peak(p, "hp", max);
            var stamina = zdo.GetFloat(ZDOVars.s_stamina, -1f);
            if (stamina >= 0f)
            {
                Peak(p, "st", stamina);
                var empty = stamina < 1f;
                if (empty)
                    Gather.Add("exh", p, "", 1);
                if (empty && !s.Exhausted)
                    Gather.Add("exhn", p, "", 1);
                s.Exhausted = empty;
            }
            var eitr = zdo.GetFloat(ZDOVars.s_eitr, 0f);
            if (eitr > 0f)
                Peak(p, "eitr", eitr);
            if (zdo.GetInt(Crouching) != 0)
                Gather.Add("crouch", p, "", 1);
            var emoteId = zdo.GetInt(ZDOVars.s_emoteID);
            if (s.EmoteId >= 0 && emoteId != s.EmoteId)
            {
                var emote = zdo.GetString(ZDOVars.s_emote);
                if (!string.IsNullOrEmpty(emote))
                    Gather.Add("emote", p, emote, 1);
            }
            s.EmoteId = emoteId;
            var inBed = zdo.GetBool(ZDOVars.s_inBed);
            if (inBed && !s.InBed && EnvMan.IsNight())
                Gather.Add("bed", p, "", 1);
            s.InBed = inBed;

            // ---- close calls: below 10 % of max, back above half, alive throughout
            if (!dead && max > 0f)
            {
                if (hp < max * CloseCall)
                {
                    s.InDanger = true;
                    if (hp < s.LowHp) { s.LowHp = hp; s.LowMax = max; }
                }
                else if (s.InDanger && hp > max * Recovered)
                {
                    Event(p, "closecall", ("hp", s.LowHp), ("max", s.LowMax));
                    s.InDanger = false;
                    s.LowHp = float.PositiveInfinity;
                }
            }

            // ---- movement
            if (dead || pos.y > Interior)
            {
                EndSprint(s, p);
                s.HasPos = false;
                s.FallAt = -1f;
                return;
            }
            if (s.HasPos)
            {
                var flat = new Vector2(pos.x - s.Pos.x, pos.z - s.Pos.z).magnitude;
                var dy = pos.y - s.Pos.y;
                if (flat > Teleport)
                {
                    EndSprint(s, p);
                }
                else
                {
                    var ground = WorldGenerator.instance != null ? WorldGenerator.instance.GetHeight(pos.x, pos.z) : 0f;
                    var overWater = ground < water - 1f;
                    var mode = pos.y < water - 1f && ground < pos.y - 0.5f ? "swim" : overWater && pos.y > water - 0.6f ? "boat" : "foot";
                    if (mode == "foot" && flat > 2f && (s.Tick % 5 == 0 || flat > SprintSpeed))
                        s.Riding = OnMount(pos);
                    if (mode == "foot" && s.Riding)
                        mode = "ride";
                    if (flat > 0.3f)
                    {
                        Gather.Add("dist", p, mode, flat);
                        Peak(p, "v_" + mode, flat);
                    }
                    // a sprint: on foot, faster than jogging, second after second
                    if (mode == "foot" && flat >= SprintSpeed)
                    {
                        s.SprintM += flat;
                        s.SprintS += 1f;
                    }
                    else
                        EndSprint(s, p);
                    // a fall: from the last point it wasn't dropping, onto land, fast and mostly straight down
                    if (-dy > 6f && -dy > 1.5f * flat)
                        s.Dropping = true;
                    if (dy > -1f)
                    {
                        if (s.Dropping && s.PeakY - pos.y >= FallMin && mode == "foot" && s.FallAt < 0f)
                        {
                            s.FallH = s.PeakY - pos.y;
                            s.FallAt = Time.time;
                        }
                        s.PeakY = pos.y;
                        s.Dropping = false;
                    }
                }
            }
            if (s.FallAt >= 0f && Time.time - s.FallAt >= 5f)
            {
                Event(p, "fall", ("h", s.FallH));
                s.FallAt = -1f;
            }
            Peak(p, "y", pos.y - water);
            s.Pos = pos;
            s.HasPos = true;
        }

        private static bool OnMount(Vector3 pos)
        {
            Near.Clear();
            ZDOMan.instance.FindSectorObjects(ZoneSystem.GetZone(pos), new SimulationDistance(0, 0, classic: true), Near);
            foreach (var z in Near)
                if (Mounts.Contains(z.GetPrefab()) && z.GetBool(ZDOVars.s_haveSaddleHash) && Vector3.Distance(z.GetPosition(), pos) < 2.5f)
                    return true;
            return false;
        }

        private static void EndSprint(State s, string p)
        {
            if (p != null && s.SprintS >= 5f)
                Event(p, "sprint", ("m", s.SprintM), ("s", s.SprintS));
            s.SprintM = 0f;
            s.SprintS = 0f;
        }

        private static void Event(string p, string e, params (string k, float v)[] values)
        {
            var sb = new StringBuilder("{\"e\":");
            Gather.Json(sb, e).Append(",\"p\":");
            Gather.Json(sb, p).Append(",\"n\":1");
            foreach (var (k, v) in values)
                sb.Append(",\"").Append(k).Append("\":").Append((Mathf.Round(v * 10f) / 10f).ToString(CultureInfo.InvariantCulture));
            Events.Emit(sb.Append('}').ToString());
        }

        // once a minute with the gather lines
        internal static void Flush()
        {
            foreach (var kv in Peaks)
            {
                var sb = new StringBuilder("{\"e\":\"peak\",\"p\":");
                Gather.Json(sb, kv.Key.p).Append(",\"i\":");
                Gather.Json(sb, kv.Key.k).Append(",\"n\":").Append((Mathf.Round(kv.Value * 10f) / 10f).ToString(CultureInfo.InvariantCulture)).Append('}');
                Events.Emit(sb.ToString());
            }
            Peaks.Clear();
        }
    }
}
