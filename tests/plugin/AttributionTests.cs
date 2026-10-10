// The attribution rules (docs/ATTRIBUTION.md): what each must do, and what it must never do ("guard") — in group
// situations too, which a solo session can't show. The invariants they keep (I1–I5) are in docs/ATTRIBUTION.md, "Checks".
//   blood magic   a health-cost attack's cost is health paid, not damage taken
//   deaths        health 0, a ragdoll of its own kind (several kinds can share one), or its own loot from the same client
//   evidence      who killed it: the attacker list, the game's kill note, a routed hit, one's own attack just before in reach
//   unaccounted   a death with no evidence for its killer is `ukill` (no player), never guessed from who is near
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
        m.Ragdolls["Hare_ragdoll"] = new List<string> { "Hare" };
        m.Names["Greyling"] = "$enemy_greyling";
        m.Names["Boar"] = "$enemy_boar";
        m.Names["Hare"] = "$animal_hare";
        m.Weapons["THSwordKrom"] = (false, 2.8f, true);
        m.Weapons["BowDraugrFang"] = (true, 0f, true);
        m.Weapons["StaffShield"] = (false, 0f, false);
        return m;
    }

    static Sim New()
    {
        var s = new Sim();
        s.Core.Meta(TestMeta());
        return s;
    }

    static Vec Off(Vec v, float dx, float dz = 0) => new Vec(v.X + dx, v.Y, v.Z + dz);
    const long Client = 1234567, Other = 999, Owner = 555; // Owner: another client that ran the creature

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

        // ======== deaths: health 0, a ragdoll of its own kind, its own loot ========
        var seeker = Off(Here, 0, 0);
        PlayerState M(Vec at) => P("M", at, held: "StaffFireball");
        {
            // a recorded session: Seeker*1 deleted at 8.7 of 400 right after a drop, no ragdoll, its loot from the same client
            var s = New();
            s.Core.Attack(442f, "M", "StaffFireball");
            s.Core.CreatureHealth(442.4f, "1:60", "Seeker*1", seeker, 25f, 8.7f, L(M(Off(seeker, 6))));
            s.Core.Destroyed(442.4f, "1:60", "Seeker*1", false, seeker, 8.7f, 400f, L(M(Off(seeker, 6))), L(M(Off(seeker, 6))), by: Client);
            s.Core.Loot(442.45f, Client + ":900", "Carapace", Client, Off(seeker, 0.5f));
            s.Core.Tick(450f, L(M(Off(seeker, 6))));
            check(s.Get("kill", "M", "Seeker*1") == 1 && Near(s.Get("dmg", "M", "Seeker*1"), 16.3 + 8.7),
                "deaths: deleted with health left, no ragdoll, its own loot from the client that deleted it: a kill, and the last 8.7 as damage");
        }
        void NoKill(string what, string item, long by, float dx, float dt, string kind = "Seeker")
        {
            var s = New();
            s.Core.CreatureHealth(10f, "1:61", kind, seeker, 50f, 20f, L(M(Off(seeker, 6))));
            s.Core.Destroyed(10.2f, "1:61", kind, false, seeker, 20f, 400f, L(M(Off(seeker, 6))), L(M(Off(seeker, 6))), by: Client);
            s.Core.Loot(10.2f + dt, by + ":901", item, by, Off(seeker, dx));
            s.Core.Tick(20f, L(M(Off(seeker, 6))));
            check(s.Sum("kill", "M") == 0, "deaths guard: " + what);
        }
        NoKill("loot not in its drop table is no death (an item someone dropped)", "Wood", Client, 0.5f, 0.05f);
        NoKill("its loot, but created by another client, is no death", "Carapace", Other, 0.5f, 0.05f);
        NoKill("its loot 5 m away is no death", "Carapace", Client, 5f, 0.05f);
        NoKill("its loot 3 s later is no death", "Carapace", Client, 0.5f, 3f);
        NoKill("a creature deleted on a timer (enemy summon) needs health 0, loot isn't enough", "Coal", Client, 0.5f, 0.05f,
            "Charred_Twitcher_Summoned");
        {
            // two Ticks of a pack die together, each with its own loot
            var s = New();
            var t1 = Off(Here, 0);
            var t2 = Off(Here, 1);
            foreach (var (uid, at) in new[] { ("1:70", t1), ("1:71", t2) })
            {
                s.Core.CreatureHealth(20f, uid, "Tick", at, 50f, 10f, L(M(Off(Here, 4))));
                s.Core.Destroyed(20.1f, uid, "Tick", false, at, 10f, 50f, L(M(Off(Here, 4))), L(M(Off(Here, 4))), by: Client);
            }
            s.Core.Loot(20.15f, Client + ":902", "GiantBloodSack", Client, Off(t1, 0.3f));
            s.Core.Loot(20.15f, Client + ":903", "GiantBloodSack", Client, Off(t2, 0.3f));
            s.Core.Tick(30f, L(M(Off(Here, 4))));
            check(s.Get("kill", "M", "Tick") == 2, "deaths: two of a kind dying together, each with its loot: two kills (I3: each once)");
            check(s.Get("kill", "M", "Tick") <= 2, "deaths guard (I3): never more kills than deaths");
        }
        {
            // a deletion in the middle of a fight that no signal explains: visible as `gone`, not silently lost
            var s = New();
            s.Core.CreatureHealth(30f, "1:72", "Seeker", seeker, 200f, 120f, L(M(Off(seeker, 6))));
            s.Core.Destroyed(31f, "1:72", "Seeker", false, seeker, 120f, 200f, L(M(Off(seeker, 6))), L(M(Off(seeker, 6))), by: Client);
            s.Core.Tick(40f, L(M(Off(seeker, 6))));
            check(s.Get("gone", "", "Seeker") == 1 && s.Sum("kill", "M") == 0,
                "deaths: deleted 1 s after damage, no signal: `gone` (possible missed kill), no kill");
        }
        {
            // a Troll's ragdoll next to a Greyling deleted with health left — not the Greyling's death
            var s = New();
            s.Core.CreatureHealth(50f, "1:80", "Greyling", Here, 40f, 10f, L(M(Off(Here, 3))));
            s.Core.Destroyed(50.1f, "1:80", "Greyling", false, Here, 10f, 40f, L(M(Off(Here, 3))), L(M(Off(Here, 3))), by: Client);
            s.Core.Ragdoll(50.2f, "1:81", "Troll", 1, Off(Here, 1), "Troll_ragdoll");
            s.Core.Tick(60f, L(M(Off(Here, 3))));
            check(s.Get("kill", "M", "Greyling") == 0, "deaths: a ragdoll only matches a creature of its own kind (a Troll's can't be the Greyling's death)");
        }
        {
            // a shared ragdoll matches its own deletion: the kill keeps the deleted creature's name
            var s = New();
            s.Core.CreatureHealth(60f, "1:82", "GoblinArcher", Here, 40f, 10f, L(M(Off(Here, 3))));
            s.Core.Destroyed(60.1f, "1:82", "GoblinArcher", false, Here, 10f, 40f, L(M(Off(Here, 3))), L(M(Off(Here, 3))), by: Client);
            s.Core.Ragdoll(60.2f, "1:83", "Goblin", 1, Off(Here, 0.5f), "Goblin_ragdoll");
            s.Core.Tick(70f, L(M(Off(Here, 3))));
            check(s.Get("kill", "M", "GoblinArcher") == 1 && s.Get("kill", "M", "Goblin") == 0,
                "deaths guard: a ragdoll shared by Goblin and GoblinArcher, matched to a GoblinArcher's deletion: one GoblinArcher kill");
        }


        // ======== unaccounted kills ========
        {
            // a recorded session, Tick#1005: its loot says it died, nobody on its list, no summon attack in reach in time
            var s = New();
            s.Core.Destroyed(342.8f, "1795:1005", "Tick", false, Here, null, 50f, L(), L(M(Off(Here, 6))), by: Client);
            s.Core.Loot(342.85f, Client + ":905", "GiantBloodSack", Client, Off(Here, 0.3f));
            s.Core.Tick(350f, L(M(Off(Here, 6))));
            check(s.Get("ukill", "", "Tick") == 1 && s.Sum("kill", "M") == 0 && s.Sum("dmg", "M") == 0,
                "unaccounted: a death without evidence for its killer is `ukill` — the player 6 m away is not guessed");
        }
        {
            // a trap / turret / another creature: health 0, nobody on the list
            var s = New();
            s.Core.CreatureHealth(20f, "1:90", "Boar", Here, 30f, 0f, L());
            s.Core.Destroyed(20.1f, "1:90", "Boar", false, Here, 0f, 30f, L(), L(M(Off(Here, 4))), by: Client);
            s.Core.Tick(30f, L(M(Off(Here, 4))));
            check(s.Get("ukill", "", "Boar") == 1 && s.Sum("kill", "M") == 0, "unaccounted: health 0 with nobody to credit");
        }
        {
            // a shared ragdoll whose deletion never showed: every kind it can be, not the first one
            var s = New();
            s.Core.Ragdoll(40f, "1:91", "Goblin", 2, Here, "Goblin_ragdoll");
            s.Core.Tick(45f, L(M(Off(Here, 3))));
            check(s.Get("ukill", "", "Goblin/GoblinArcher*1") == 1 && s.Sum("kill", "M") == 0,
                "unaccounted: a shared ragdoll without its deletion is named by every kind it can be, with its stars");
        }
        {
            var s = New();
            s.Core.Attack(9f, "M", "SwordIron");
            s.Core.CreatureHealth(10f, "1:92", "Boar", Here, 30f, 0f, L(M(Off(Here, 2))));
            s.Core.Destroyed(10.1f, "1:92", "Boar", false, Here, 0f, 30f, L(M(Off(Here, 2))), L(M(Off(Here, 2))), by: Client);
            s.Core.Ragdoll(10.2f, "1:93", "Boar", 1, Here, null);
            s.Core.Tick(20f, L(M(Off(Here, 2))));
            check(s.Get("kill", "M", "Boar") == 1 && s.Out.Keys.All(k => k.Item1 != "ukill"),
                "unaccounted guard: a credited death is never also unaccounted (its ragdoll finds it counted)");
        }

        {
            // a recorded session: Bonemass deleted with 40.7 of 5,000 left; its loot (no table in that session's meta) and the
            // game's kill note from the client that ran it to the other fighter — the note alone says it died
            var s = New();
            var fighters = L(P("Stick", Off(Here, 4)), P("Söder", Off(Here, -4)));
            s.Core.CreatureHealth(8312.3f, "9:21170", "Bonemass", Here, 80f, 40.7f, fighters);
            s.Core.Destroyed(8312.6f, "9:21170", "Bonemass", false, Here, 40.7f, 5000f, fighters, fighters, by: Owner);
            s.Core.KillNote(8312.6f, Owner, "Söder", "$enemy_bonemass");
            s.Core.Tick(8320f, fighters);
            check(s.Get("kill", "Stick", "Bonemass") == 1 && s.Get("kill", "Söder", "Bonemass") == 1 && s.Sum("ukill", "") == 0,
                "deaths: the game's kill note alone makes a deletion with health left a death — for everyone in the fight");
        }
        {
            // a boss's loot spawns at its centre, metres above its position
            var s = New();
            s.Core.CreatureHealth(30f, "1:95", "Seeker", seeker, 30f, 8f, L(M(Off(seeker, 4))));
            s.Core.Destroyed(30.2f, "1:95", "Seeker", false, seeker, 8f, 400f, L(M(Off(seeker, 4))), L(M(Off(seeker, 4))), by: Client);
            s.Core.Loot(30.23f, Client + ":906", "Carapace", Client, new Vec(seeker.X + 0.2f, seeker.Y + 3.2f, seeker.Z));
            s.Core.Tick(40f, L(M(Off(seeker, 4))));
            check(s.Get("kill", "M", "Seeker") == 1, "deaths: loot counts by its horizontal distance (it spawns at the centre, metres up)");
        }

        // ======== evidence for the killer, when its attacker list never synced (one-hit kills) ========

        PlayerState Stick(float dx) => P("Stick", Off(Here, dx), held: "THSwordKrom");
        void OneHit(Sim s, float t, string uid, string kind, long by, Vec at, List<PlayerState> players, string ragdoll = null)
        {
            s.Core.Destroyed(t, uid, kind, false, at, null, 20f, L(), players, by: by);
            if (ragdoll != null)
                s.Core.Ragdoll(t + 0.2f, uid + "r", kind, 1, at, ragdoll);
        }
        {
            // a recorded session: Stick one-shot a Greyling that Dr Markus Söder's client ran; its note named Stick
            var s = New();
            OneHit(s, 7163.1f, "1:40907", "Greyling", Owner, Here, L(Stick(5)), "Greyling_ragdoll");
            s.Core.KillNote(7163.14f, Owner, "Stick", "$enemy_greyling");
            s.Core.Tick(7170f, L(Stick(5)));
            check(s.Get("kill", "Stick", "Greyling") == 1 && s.Sum("ukill", "") == 0, "evidence: the game's kill note names the killer");
        }
        void NoNote(string what, long from, string token, float dt)
        {
            var s = New();
            OneHit(s, 10f, "1:1", "Greyling", Owner, Here, L(Stick(5)), "Greyling_ragdoll");
            s.Core.KillNote(10f + dt, from, "Stick", token);
            s.Core.Tick(20f, L(Stick(5)));
            check(s.Sum("kill", "Stick") == 0 && s.Get("ukill", "", "Greyling") == 1, "evidence guard: " + what);
        }
        NoNote("a kill note from another client is no evidence for this death", 777, "$enemy_greyling", 0.05f);
        NoNote("a kill note of another kind is no evidence for this death", Owner, "$enemy_boar", 0.05f);
        NoNote("a kill note 10 s later is no evidence for this death", Owner, "$enemy_greyling", 10f);
        {
            var s = New();
            s.Core.Hit(9f, "1:2", "Stick", 45f);
            OneHit(s, 9.1f, "1:2", "Greyling", Owner, Here, L(Stick(20)), "Greyling_ragdoll");
            s.Core.Tick(15f, L(Stick(20)));
            check(s.Get("kill", "Stick", "Greyling") == 1, "evidence: a routed hit of theirs on it");
        }
        {
            var s = New();
            s.Core.Hit(9f, "1:3", "Stick", 0f); // a shield or a status effect: no damage
            OneHit(s, 9.1f, "1:3", "Greyling", Owner, Here, L(Stick(20)), "Greyling_ragdoll");
            s.Core.Tick(15f, L(Stick(20)));
            check(s.Sum("kill", "Stick") == 0, "evidence guard: a routed hit without damage is no evidence");
        }
        void Struck(string what, string weapon, float before, float dx, bool kill)
        {
            var s = New();
            s.Core.Attack(100f - before, "Stick", weapon);
            OneHit(s, 100f, "1:4", "Hare", Client, Here, L(Stick(dx)), "Hare_ragdoll");
            s.Core.Tick(110f, L(Stick(dx)));
            check(kill ? s.Get("kill", "Stick", "Hare") == 1 && Near(s.Get("dmg", "Stick", "Hare"), 20) : s.Sum("kill", "Stick") == 0 && s.Get("ukill", "", "Hare") == 1,
                (kill ? "evidence: " : "evidence guard: ") + what);
        }
        Struck("their own melee swing 0.6 s before, 2 m away (and its health as damage)", "THSwordKrom", 0.6f, 2f, true);
        Struck("their own bow shot 0.3 s before, 8 m away", "BowDraugrFang", 0.3f, 8f, true);
        Struck("a melee swing 2 s before is no evidence", "THSwordKrom", 2f, 2f, false);
        Struck("a melee swing 10 m away is no evidence", "THSwordKrom", 0.6f, 10f, false);
        Struck("a bow shot 80 m away is no evidence", "BowDraugrFang", 0.3f, 80f, false);
        Struck("a cast without damage (shield) is no evidence", "StaffShield", 0.5f, 2f, false);
        {
            // a shot 30 m away just before a death that the attacker list already explains: not the archer's kill
            var s = New();
            s.Core.Attack(99.6f, "Stick", "BowDraugrFang");
            s.Core.CreatureHealth(99.9f, "1:8", "Boar", Here, 20f, 0f, L(P("Astrid", Off(Here, 2))));
            s.Core.Destroyed(100f, "1:8", "Boar", false, Here, 0f, 20f, L(P("Astrid", Off(Here, 2))), L(Stick(30), P("Astrid", Off(Here, 2))), by: Client);
            s.Core.Tick(110f, L(Stick(30)));
            check(s.Get("kill", "Astrid", "Boar") == 1 && s.Sum("kill", "Stick") == 0,
                "evidence guard: a shot from afar only counts when nothing else explains the death");
        }
        {
            // one swing, two hares dying in reach at once: it killed one of them
            var s = New();
            s.Core.Attack(99.5f, "Stick", "THSwordKrom");
            OneHit(s, 100f, "1:5", "Hare", Client, Here, L(Stick(2)), "Hare_ragdoll");
            OneHit(s, 100f, "1:6", "Hare", Client, Off(Here, 1), L(Stick(2)), "Hare_ragdoll");
            s.Core.Tick(110f, L(Stick(2)));
            check(s.Get("kill", "Stick", "Hare") == 1 && s.Get("ukill", "", "Hare") == 1, "evidence guard (I2): one attack is evidence for one death");
        }
        {
            // two players both struck it just before: everyone who hit it
            var s = New();
            s.Core.Attack(99.5f, "Stick", "THSwordKrom");
            s.Core.Attack(99.7f, "Astrid", "THSwordKrom");
            OneHit(s, 100f, "1:7", "Hare", Client, Here, L(Stick(2), P("Astrid", Off(Here, -2)), P("Ragnar", Off(Here, 3))), "Hare_ragdoll");
            s.Core.Tick(110f, L(Stick(2)));
            check(s.Get("kill", "Stick", "Hare") == 1 && s.Get("kill", "Astrid", "Hare") == 1 && s.Sum("kill", "Ragnar") == 0,
                "evidence (group): both players who struck it get the kill, the one standing next to it who didn't, nothing");
        }
    }
}
