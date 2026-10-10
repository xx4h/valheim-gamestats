// CombatCore as released in 1.20.11, pinned: every rule of plugin/Combat.cs's header as a scenario, including the
// known weaknesses (marked "known gap") — the PRs that fix them change these tests visibly. Plus the trace round trip:
// a session recorded with CombatTrace and replayed gives exactly what the plugin made of it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ValheimGamestats;

static partial class CombatTests
{
    // a core and what it wrote: (event, player, object) → sum
    class Sim
    {
        public readonly Dictionary<(string, string, string), double> Out = new Dictionary<(string, string, string), double>();
        public readonly CombatCore Core;

        public Sim(bool trace = false)
        {
            Core = new CombatCore((e, p, i, n) =>
            {
                p ??= ""; // events without a player ("gone": a deletion no signal explains)
                Out.TryGetValue((e, p, i), out var have);
                Out[(e, p, i)] = have + n;
                if (trace && (p != "" || e == "ukill"))
                    CombatTrace.Out(e, p, i, n);
            });
        }

        public double Get(string e, string p, string i) => Out.TryGetValue((e, p, i), out var v) ? v : 0;
        public double Sum(string e, string p) => Out.Where(kv => kv.Key.Item1 == e && kv.Key.Item2 == p).Sum(kv => kv.Value);
    }

    static readonly Vec Here = new Vec(100, 30, 100);
    static PlayerState P(string name, Vec pos, string held = "SwordIron", bool dead = false) => new PlayerState(name, true, dead, pos, held);
    static PlayerState Gone(string name) => new PlayerState(name, false, false, default, null);
    static Vec At(float dx) => new Vec(Here.X + dx, Here.Y, Here.Z);
    static List<PlayerState> L(params PlayerState[] p) => p.ToList();
    static bool Near(double a, double b) => Math.Abs(a - b) < 1e-3;

    internal static void Run(Action<bool, string> check)
    {
        RunAttribution(check);
        // ---- damage dealt
        {
            var s = new Sim();
            s.Core.Attack(9f, "Ragnar", "SwordIron");
            s.Core.Attack(9.5f, "Ragnar", "SwordIron");
            s.Core.Attack(10f, "Astrid", "Bow");
            s.Core.CreatureHealth(11f, "1:1", "Troll", Here, 600f, 540f, L(P("Ragnar", At(2)), P("Astrid", At(30))));
            check(Near(s.Get("dmg", "Ragnar", "Troll"), 40) && Near(s.Get("dmg", "Astrid", "Troll"), 20),
                "damage: a health drop split per attack in the 3 s before it, one share each (60 = 2 swings + 1 shot)");
            check(Near(s.Get("dw", "Astrid", "Bow>Troll"), 20) && Near(s.Get("wdmg", "Ragnar", "SwordIron"), 40),
                "damage: per weapon, and per weapon and creature");
        }
        {
            var s = new Sim();
            s.Core.Attack(1f, "Ragnar", "AxeBronze"); // 10 s before: outside the window, but their last weapon
            s.Core.CreatureHealth(11f, "1:1", "Boar", Here, 30f, 20f, L(P("Ragnar", At(1)), P("Astrid", At(1), held: "Club")));
            check(s.Sum("dmg", "Ragnar") == 0 && s.Sum("dmg", "Astrid") == 0 && Near(s.Get("udmg", "", "Boar"), 10),
                "damage: no attack in the window and nothing else that explains it — unattributed, never spread over the list");
        }
        {
            var s = new Sim();
            s.Core.Attack(10f, "Ragnar", "SwordIron");
            s.Core.Attack(10f, "Astrid", "SwordIron");
            s.Core.Attack(10f, "Bjorn", "SwordIron");
            s.Core.CreatureHealth(11f, "1:1", "Troll", Here, 600f, 570f,
                L(P("Ragnar", At(5)), P("Astrid", At(70)), P("Bjorn", At(5), dead: true), Gone("Leif")));
            check(Near(s.Get("dmg", "Ragnar", "Troll"), 30) && s.Sum("dmg", "Astrid") == 0 && s.Sum("dmg", "Bjorn") == 0,
                "damage: only attackers alive and within 60 m count");
        }
        {
            var s = new Sim();
            s.Core.CreatureHealth(11f, "1:1", "Troll", Here, 600f, 599.995f, L(P("Ragnar", At(1))));
            s.Core.CreatureHealth(12f, "1:1", "Troll", Here, 500f, 600f, L(P("Ragnar", At(1))));
            check(s.Out.Count == 0, "damage: no drop (≤ 0.01) and healing are not damage");
        }
        {
            var s = new Sim();
            s.Core.Attack(10f, "Ragnar", "StaffFireball");
            s.Core.CreatureHealth(11f, "1:1", "Troll", Here, 600f, 480f, L(P("Ragnar", At(1)), P("Astrid", At(1))));
            s.Core.CreatureHealth(16f, "1:1", "Troll", Here, 480f, 460f, L(P("Ragnar", At(1)), P("Astrid", At(1))));
            check(s.Sum("dmg", "Astrid") == 0 && Near(s.Get("udmg", "", "Troll"), 20),
                "damage over time: a burn tick after the window, with the weapon's fire unknown — unattributed, not split over the list");
        }

        // ---- kills
        {
            var s = new Sim();
            s.Core.Attack(10f, "Ragnar", "SwordIron");
            s.Core.CreatureHealth(10.5f, "1:1", "Troll*1", Here, 50f, -5f, L(P("Ragnar", At(3)), P("Astrid", At(3))));
            s.Core.Destroyed(12f, "1:1", "Troll*1", false, Here, 0f, 1200f, L(P("Ragnar", At(3), dead: true)), L(P("Ragnar", At(3))));
            check(s.Out.Keys.All(k => k.Item1 != "kill"), "kill: not at the deletion itself — the game's kill note can still be on its way");
            s.Core.Tick(15f, L(P("Ragnar", At(3))));
            check(s.Get("kill", "Ragnar", "Troll*1") == 1 && s.Get("kill", "Astrid", "Troll*1") == 1,
                "kill: 3 s after a deletion with health ≤ 0, for whoever was in the fight at health 0 (even if dead since)");
            check(s.Get("kw", "Ragnar", "SwordIron>Troll*1") == 1, "kill: with the weapon of their last attack");
            s.Core.Ragdoll(12.2f, "9:9", "Troll", 2, Here);
            s.Core.Tick(16f, L(P("Ragnar", At(1))));
            check(s.Get("kill", "Ragnar", "Troll*1") == 1, "kill: its ragdoll finds it counted — no second kill");
        }
        {
            var s = new Sim();
            s.Core.Destroyed(20f, "2:2", "Greyling", false, Here, 25f, 40f, L(P("Ragnar", At(2))), L(P("Ragnar", At(2), held: "Club")));
            check(s.Out.Count == 0, "kill: deleted with health left — not a kill by itself");
            s.Core.Ragdoll(20.1f, "8:8", "Greyling", 1, At(1));
            s.Core.Tick(22f, L(P("Ragnar", At(2), held: "Club")));
            check(s.Out.Count == 0, "kill: the ragdoll waits 3 s for the deletion");
            s.Core.Tick(23.2f, L(P("Ragnar", At(2), held: "Club")));
            check(s.Get("kill", "Ragnar", "Greyling") == 1 && Near(s.Get("dmg", "Ragnar", "Greyling"), 25),
                "kill: a one-hit kill (health never synced) — the ragdoll: its attackers, and its last known health as damage");
        }
        {
            var s = new Sim();
            s.Core.Ragdoll(30f, "7:7", "Neck", 3, At(5));
            s.Core.Tick(33.5f, L(P("Astrid", At(20)), P("Ragnar", At(10), held: "Bow")));
            check(s.Sum("kill", "Ragnar") == 0 && s.Sum("kill", "Astrid") == 0 && s.Get("ukill", "", "Neck*2") == 1,
                "kill: a ragdoll with no known death — nobody is guessed from being near: an unaccounted kill, named with its stars");
        }
        {
            var s = new Sim();
            s.Core.Destroyed(50f, "3:3", "Wolf", true, Here, 0f, 80f, L(P("Ragnar", At(1))), L(P("Ragnar", At(1))));
            s.Core.Ragdoll(50.2f, "5:5", "Wolf", 1, Here);
            s.Core.Tick(54f, L(P("Ragnar", At(1))));
            check(s.Out.Count == 0, "kill: a pet is never a kill — not even through its ragdoll");
        }
        {
            var s = new Sim();
            // Bonemass deleted with health left (its last update lost), a Blob counted dying next to it, one ragdoll each
            s.Core.CreatureHealth(60f, "b:1", "Blob", At(1), 50f, 0f, L(P("Ragnar", At(3))));
            s.Core.Destroyed(60.5f, "b:1", "Blob", false, At(1), 0f, 50f, L(P("Ragnar", At(3))), L(P("Ragnar", At(3))));
            s.Core.Destroyed(60.6f, "m:1", "Bonemass", false, Here, 120f, 5000f, L(P("Ragnar", At(3))), L(P("Ragnar", At(3))));
            s.Core.Ragdoll(60.7f, "r:1", "Bonemass", 1, At(1)); // its ragdoll lands nearer the Blob's death
            s.Core.Tick(65f, L(P("Ragnar", At(3))));
            check(s.Get("kill", "Ragnar", "Bonemass") == 0,
                "without the ragdolls' kinds (older traces): a ragdoll matches the nearest death of any creature — the Blob's took Bonemass's (with them: the deaths in AttributionTests)");
        }

        // ---- damage taken
        {
            var s = new Sim();
            check(Near(s.Core.PlayerHealth("Ragnar", 100f, 70f, 120f, 120f), 30) && Near(s.Get("taken", "Ragnar", ""), 30) && s.Get("hit", "Ragnar", "") == 1,
                "taken: a player's health drop, and one hit");
            check(s.Core.PlayerHealth("Ragnar", 150f, 120f, 150f, 120f) == 0, "taken: food wearing off (health clamped to the new max) is not damage");
            check(s.Core.PlayerHealth("Ragnar", 100f, 99.995f, 120f, 120f) == 0, "taken: no drop, no hit");
        }

        // ---- weapons of players who left
        {
            var s = new Sim();
            s.Core.Tick(1f, L(P("Ragnar", At(1), held: "Bow")));
            s.Core.Tick(2f, L()); // Ragnar left
            s.Core.Ragdoll(3f, "4:4", "Deer", 1, At(1));
            s.Core.Destroyed(3f, "d:1", "Deer", false, At(1), 5f, 10f, L(), L(P("Ragnar", At(1), held: "Bow")));
            s.Core.Tick(7f, L());
            check(s.Out.Keys.All(k => k.Item1 == "ukill") && s.Get("ukill", "", "Deer") == 1,
                "a player who left gets nothing from a ragdoll: an unaccounted kill");
        }

        // ---- the trace round trip
        {
            var dir = Directory.CreateTempSubdirectory("trace").FullName;
            CombatTrace.Init(dir);
            CombatTrace.Enabled = true;
            var s = new Sim(trace: true);
            void Attack(float t, string p, string w) { CombatTrace.Attack(t, p, w); s.Core.Attack(t, p, w); }
            void Health(float t, string u, string m, Vec pos, float b, float a, List<PlayerState> l)
            { CombatTrace.Health(t, u, m, pos, b, a, l); s.Core.CreatureHealth(t, u, m, pos, b, a, l); }
            void Destroy(float t, string u, string m, bool tamed, Vec pos, float? h, float? mh, List<PlayerState> l, List<PlayerState> ps)
            { CombatTrace.Destroyed(t, u, m, tamed, pos, h, mh, l, ps, false); s.Core.Destroyed(t, u, m, tamed, pos, h, mh, l, ps); }
            void Rag(float t, string u, string c, int lv, Vec pos) { CombatTrace.Ragdoll(t, u, c, lv, pos); s.Core.Ragdoll(t, u, c, lv, pos); }
            void Tick(float t, List<PlayerState> ps) { CombatTrace.Tick(t, ps); s.Core.Tick(t, ps); }

            var party = L(P("Ragnar", At(2)), P("Astrid \"the Bold\"", At(8), held: "Bow"));
            Attack(10f, "Ragnar", "SwordIron");
            Attack(10.2f, "Astrid \"the Bold\"", "Bow");
            Health(11f, "1:1", "Troll*1", Here, 1200f, 1100f, party);
            Health(12f, "1:1", "Troll*1", Here, 1100f, 0f, party);
            Destroy(13f, "1:1", "Troll*1", false, Here, 0f, 1200f, party, party);
            Rag(13.1f, "2:2", "Troll", 2, Here);
            Destroy(14f, "3:3", "Greyling", false, At(4), null, null, L(), party);
            Rag(14.1f, "4:4", "Greyling", 1, At(4));
            // the facts CombatCore doesn't use: in between, with quotes and ids beyond a double's precision
            var meta = new CombatMeta();
            meta.Ragdolls["Goblin_ragdoll"] = new List<string> { "Goblin", "GoblinArcher" };
            meta.Costs["StaffSkeleton/staff_summon"] = (0f, 40f);
            meta.Drops["Tick"] = new Dictionary<string, float> { ["GiantBloodSack"] = 1f };
            meta.Timed.Add("Charred_Twitcher_Summoned");
            meta.Reach["Skeleton_Friendly/attack_bow"] = 30f;
            CombatTrace.Meta(new List<string> { "Seeker", "Odd \"one\"" }, meta);
            CombatTrace.Trigger(13.2f, "5:5", "Skeleton_Friendly", "attack", "Astrid \"the Bold\"", true, 9007199254740993L, Here);
            CombatTrace.Hit(13.3f, "1:1", "Troll*1", false, 9007199254740993L, "Astrid \"the Bold\"", "7:7", "player:Astrid \"the Bold\"",
                new List<(string, float)> { ("pierce", 52f), ("fire", 10f) }, "PlayerHit", "Burning", "Bows", 35f, 3, 1f, Here);
            CombatTrace.Hit(13.4f, "1:1", "Troll*1", false, 1L, "Ragnar", null, null, new List<(string, float)>(), "Turret", null, "None", 0f, 1, 1f, Here);
            CombatTrace.KillNote(13.5f, "Ragnar", "Astrid \"the Bold\"", "$enemy_troll", 0, 2);
            CombatTrace.Rise(13.6f, "6:6", "Troll", false, 300f, 340f);
            CombatTrace.PetHealth(13.7f, "5:5", "Skeleton_Friendly", "Ragnar", 400f, 320f);
            CombatTrace.Owner(13.8f, "6:6", "Troll", 1L, 2L);
            CombatTrace.Drop(13.9f, "8:8", "TrophyTroll", 1, 2L, Here);
            Tick(18f, party);
            CombatTrace.Close();
            CombatTrace.Enabled = false;
            var file = Directory.GetFiles(Path.Combine(dir, "gamestats", "trace")).Single();
            var (now, then) = Replay.Run(file);
            check(then.Count > 0 && Replay.Same(now, then),
                $"trace: a recorded session replays to exactly what the plugin made of it ({then.Count} sums, names with quotes)");
            check(now.ContainsKey(("ukill", "", "Greyling")), "trace: missing health (null) survives the round trip");
            var facts = File.ReadLines(file).Select(l => System.Text.Json.JsonDocument.Parse(l).RootElement)
                .Where(j => j.GetProperty("k").GetString() is "meta" or "trig" or "hit" or "killnote" or "rise" or "pethp" or "owner" or "drop").ToList();
            var hit = facts.First(j => j.GetProperty("k").GetString() == "hit");
            check(facts.Count == 9 && hit.GetProperty("d").GetProperty("fire").GetDouble() == 10.0
                  && hit.GetProperty("own").GetRawText() == "9007199254740993"
                  && hit.GetProperty("am").GetString() == "player:Astrid \"the Bold\""
                  && facts[0].GetProperty("noragdoll")[1].GetString() == "Odd \"one\""
                  && facts[0].GetProperty("ragdolls").GetProperty("Goblin_ragdoll")[1].GetString() == "GoblinArcher"
                  && facts[0].GetProperty("cost").GetProperty("StaffSkeleton/staff_summon").GetProperty("p").GetDouble() == 40.0
                  && facts[0].GetProperty("drops").GetProperty("Tick").GetProperty("GiantBloodSack").GetDouble() == 1.0
                  && facts[0].GetProperty("timed")[0].GetString() == "Charred_Twitcher_Summoned"
                  && facts[0].GetProperty("reach").GetProperty("Skeleton_Friendly/attack_bow").GetDouble() == 30.0,
                "trace: the facts (meta, trig, hit, killnote, rise, pethp, owner, drop) are valid JSON, ids exact, and replay skips them");
        }
    }
}
