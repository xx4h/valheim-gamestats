// The attribution rules (docs/ATTRIBUTION.md): what each must do, and what it must never do ("guard") — in group
// situations too, which a solo session can't show. The invariants they keep (I1–I5) are in docs/ATTRIBUTION.md, "Checks".
//   blood magic   a health-cost attack's cost is health paid, not damage taken
using System;
using System.Collections.Generic;
using System.Linq;
using ValheimGamestats;

static partial class CombatTests
{
    static CombatMeta TestMeta()
    {
        var m = new CombatMeta();
        m.Ragdolls["Goblin_ragdoll"] = new List<string> { "Goblin", "GoblinArcher" };
        m.Ragdolls["Troll_ragdoll"] = new List<string> { "Troll" };
        m.Ragdolls["Greyling_ragdoll"] = new List<string> { "Greyling" };
        m.Drops["Tick"] = new Dictionary<string, float> { ["GiantBloodSack"] = 1f };
        m.Drops["Seeker"] = new Dictionary<string, float> { ["Carapace"] = 1f, ["TrophySeeker"] = 0.1f };
        m.Drops["Charred_Twitcher_Summoned"] = new Dictionary<string, float> { ["Coal"] = 1f };
        m.Timed.Add("Charred_Twitcher_Summoned");
        m.Costs["StaffSkeleton/staff_summon"] = (0f, 40f);
        m.Costs["StaffShield/staff_shield"] = (0f, 40f);
        m.Reach["Skeleton_Friendly/attack"] = 2.5f;
        m.Reach["Skeleton_Friendly/attack_bow"] = 30f;
        return m;
    }

    static Sim New()
    {
        var s = new Sim();
        s.Core.Meta(TestMeta());
        return s;
    }

    static Vec Off(Vec v, float dx, float dz = 0) => new Vec(v.X + dx, v.Y, v.Z + dz);
    const long Client = 1234567, Other = 999;

    static void RunAttribution(Action<bool, string> check)
    {
        // ======== blood magic: cost, not damage ========
        {
            // a recorded cast: 97.2 → 60.4 right after the Dead Raiser's trigger = 40 % × 0.947
            var s = New();
            s.Core.Attack(87f, "M", "StaffSkeleton", "staff_summon");
            s.Core.PlayerHealth("M", 97.195f, 60.370f, 157.9f, 157.9f, 87.05f);
            check(Near(s.Get("cost", "M", "StaffSkeleton"), 36.825) && s.Sum("taken", "M") == 0 && s.Sum("hit", "M") == 0,
                "blood magic: a drop right after one's own health-cost cast, within its cost range, is `cost`, not taken, not a hit");

            // second cast, a creature's hit (20) in the same health sync: cost at the learned factor, the rest taken
            s.Core.Attack(92f, "M", "StaffShield", "staff_shield");
            var cost = 100f * 0.40f * (36.825f / 38.878f);
            s.Core.PlayerHealth("M", 100f, 100f - cost - 20f, 157.9f, 157.9f, 92.05f);
            check(Near(s.Get("cost", "M", "StaffShield"), cost) && Near(s.Sum("taken", "M"), 20) && s.Sum("hit", "M") == 1,
                "blood magic: cost and a hit merged into one sync: the cost at the player's learned factor, the rest is taken + one hit");
        }
        {
            var s = New();
            s.Core.Attack(10f, "M", "StaffShield", "staff_shield");
            s.Core.PlayerHealth("M", 1.5f, 1.0f, 157.9f, 157.9f, 10.05f);
            check(Near(s.Get("cost", "M", "StaffShield"), 0.5) && s.Sum("taken", "M") == 0,
                "blood magic: at low health the cost is capped at health − 1: still a cost");
        }
        {
            var s = New();
            s.Core.Attack(10f, "M", "StaffShield", "staff_shield");
            s.Core.PlayerHealth("M", 100f, 98f, 157.9f, 157.9f, 10.02f); // a poison tick before the cost arrives
            check(Near(s.Sum("taken", "M"), 2) && s.Sum("hit", "M") == 1,
                "blood magic guard: a drop below the cost range during a pending cost stays damage taken");
            s.Core.PlayerHealth("M", 98f, 98f - 98f * 0.4f * 0.947f, 157.9f, 157.9f, 10.1f);
            check(Near(s.Get("cost", "M", "StaffShield"), 98 * 0.4 * 0.947) && Near(s.Sum("taken", "M"), 2),
                "blood magic: … and the cost that follows is still recognised");
        }
        {
            var s = New();
            s.Core.Attack(10f, "M", "StaffShield", "staff_shield");
            s.Core.PlayerHealth("M", 100f, 62.1f, 157.9f, 157.9f, 13f);
            check(Near(s.Sum("taken", "M"), 37.9) && s.Sum("cost", "M") == 0,
                "blood magic guard: 3 s after the cast the cost is over: a drop of the same size is damage taken");
        }
        {
            var s = New();
            s.Core.Attack(10f, "Astrid", "StaffSkeleton", "staff_summon");
            s.Core.PlayerHealth("Ragnar", 100f, 62.1f, 157.9f, 157.9f, 10.05f);
            check(Near(s.Sum("taken", "Ragnar"), 37.9) && s.Sum("hit", "Ragnar") == 1 && s.Sum("cost", "Ragnar") == 0,
                "blood magic guard (I4): another player's cast never turns my damage taken into a cost");
        }
        {
            var s = New();
            s.Core.Attack(10f, "M", "SwordIron", "swing_longsword0");
            s.Core.PlayerHealth("M", 100f, 60f, 157.9f, 157.9f, 10.05f);
            check(Near(s.Sum("taken", "M"), 40) && s.Sum("cost", "M") == 0, "blood magic guard: an attack without a health cost never makes a cost");
        }
    }
}
