// The combat logic without the game: what Combat.cs (the adapter) sees, as plain values, in; the per-minute lines out.
// The adapter reads the game's state and calls these; with tracing on it writes each call to a file too (CombatTrace),
// so tests/plugin can replay a real session through exactly this code. The rules are Combat.cs's header.
using System;
using System.Collections.Generic;

namespace ValheimGamestats
{
    internal struct Vec
    {
        public float X, Y, Z;

        public Vec(float x, float y, float z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public static float Distance(Vec a, Vec b)
        {
            float dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
            return (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
    }

    // An online player as the server sees them now: their character (none while dead or respawning), dead flag,
    // position, and the weapon in hand (Combat.HeldWeapon: bows and other left-hand weapons, else the right hand).
    internal struct PlayerState
    {
        public string Name;
        public bool Body;
        public bool Dead;
        public Vec Pos;
        public string Held;

        public PlayerState(string name, bool body, bool dead, Vec pos, string held)
        {
            Name = name;
            Body = body;
            Dead = dead;
            Pos = pos;
            Held = held;
        }
    }

    // What the game's prefabs say, once (the adapter fills it; a trace carries it as "meta"): what the attribution rules
    // need to know about creatures and items (docs/ATTRIBUTION.md). Not used by CombatCore yet.
    internal class CombatMeta
    {
        public readonly Dictionary<string, List<string>> Ragdolls = new Dictionary<string, List<string>>(); // ragdoll → creature kinds
        public readonly Dictionary<string, Dictionary<string, float>> Drops = new Dictionary<string, Dictionary<string, float>>(); // creature → item → chance
        public readonly HashSet<string> Timed = new HashSet<string>(); // deleted on a timer (enemy summons)
        public readonly Dictionary<string, (float Flat, float Percent)> Costs = new Dictionary<string, (float, float)>(); // "Item/animation" → health cost
        public readonly Dictionary<string, float> Reach = new Dictionary<string, float>(); // "Creature/animation" → reach (m)
    }

    internal class CombatCore
    {
        internal const float MatchRange = 4f;
        internal const float AttackerRange = 60f; // bow range, roughly
        internal const float HitWindow = 3f;      // swing starts → hit lands → its health sync arrives; arrows fly ~1-2 s
        internal const float MatchSeconds = 6f;
        internal const float SettleSeconds = 3f;  // let the deletion of a ragdoll's mob arrive first
        internal const float CreditRange = 15f;   // a one-hit kill without known attackers: the nearest player
        internal const float Keep = 30f;          // seconds of attack history per player

        private readonly Action<string, string, string, double> _add;              // Gather.Add
        private readonly Action<string, string, List<string>, string, Vec?> _diag; // what, creature, attackers, detail, where

        internal CombatCore(Action<string, string, string, double> add, Action<string, string, List<string>, string, Vec?> diag = null)
        {
            _add = add;
            _diag = diag ?? ((a, b, c, d, e) => { });
        }

        private class Death
        {
            public Vec Pos;
            public float Time;
            public string Name;
            public float Health;
            public List<string> Attackers;
            public bool Counted;
        }

        private class Corpse
        {
            public Vec Pos;
            public float Time;
            public string Creature;
            public int Level;
        }

        private readonly List<Death> _deaths = new List<Death>();
        private readonly List<Corpse> _corpses = new List<Corpse>();
        private readonly HashSet<string> _seenCorpses = new HashSet<string>();
        private readonly Dictionary<string, List<string>> _killers = new Dictionary<string, List<string>>(); // at health 0
        private readonly Dictionary<string, List<(float Time, string Weapon)>> _attacks =
            new Dictionary<string, List<(float, string)>>();
        private readonly Dictionary<string, string> _held = new Dictionary<string, string>();

        private CombatMeta _meta = new CombatMeta();

        // ---- inputs ----------------------------------------------------------------------------------------------

        // The prefabs' facts, once (not used yet).
        internal void Meta(CombatMeta meta) => _meta = meta ?? new CombatMeta();

        // A summon or commanded tame (`follow`: its player) started an attack (not used yet).
        internal void Summon(float t, string uid, string kind, string animation, string follow, Vec pos)
        {
        }

        // A new item object; `by`: the client that created it (its uid's user part) (not used yet: loot of a death).
        internal void Loot(float t, string uid, string item, long by, Vec pos)
        {
        }

        // A player started an attack with this weapon (Attacks.cs: the animation trigger). animation: not used yet.
        internal void Attack(float t, string player, string weapon, string animation = null)
        {
            if (!_attacks.TryGetValue(player, out var list))
                _attacks[player] = list = new List<(float, string)>();
            list.RemoveAll(a => t - a.Time > Keep);
            list.Add((t, weapon));
        }

        // A player's health changed: damage taken and one hit per drop; a drop to exactly the new, lower max health is
        // food wearing off. True when it counted (the adapter then tells Vitals).
        internal bool PlayerHealth(string player, float before, float after, float maxBefore, float maxAfter, float t = 0f)
        {
            after = Math.Max(0f, after);
            var lost = before - after;
            if (lost <= 0.01f)
                return false;
            if (maxAfter < maxBefore - 0.01f && Math.Abs(after - maxAfter) < 0.01f)
                return false;
            _add("taken", player, "", lost);
            _add("hit", player, "", 1);
            return true;
        }

        // An untamed creature's health changed. onList: the online players on its attacker list, as they are now.
        internal void CreatureHealth(float t, string uid, string mob, Vec pos, float before, float after, List<PlayerState> onList)
        {
            Remember(onList, all: false);
            var afterClamped = Math.Max(0f, after);
            var lost = before - afterClamped;
            if (lost <= 0.01f)
                return;
            var attackers = Fighting(onList, pos);
            if (afterClamped <= 0f)
            {
                // The kill is counted when the mob is deleted, which can be seconds later: whoever was in the fight
                // now keeps the kill even if they die in between (a boss's last hit often takes someone with it).
                if (_killers.Count > 1000)
                    _killers.Clear();
                _killers[uid] = attackers;
                _diag("death-sync", Prefab(mob), attackers, $"health {before:0.#}→{after:0.#}", pos);
            }
            if (attackers.Count > 0)
                Damage(attackers, mob, lost, t);
        }

        // A creature was deleted. syncedHealth: its health state (null if it has none), maxHealth likewise.
        // onList as above; players: every online player (for what they hold). info: for the diagnostic line only.
        internal void Destroyed(float t, string uid, string mob, bool tamed, Vec pos, float? syncedHealth, float? maxHealth,
            List<PlayerState> onList, List<PlayerState> players, bool fromServer = false, string info = "", long by = 0)
        {
            Remember(players, all: true);
            var death = new Death
            {
                Pos = pos,
                Time = t,
                Name = mob,
                Health = Math.Max(0f, syncedHealth ?? maxHealth ?? 0f),
                Attackers = _killers.TryGetValue(uid, out var killers) ? killers : Fighting(onList, pos),
            };
            _killers.Remove(uid);
            if (tamed)
            {
                death.Counted = true; // a pet: no kill, but its ragdoll must find this death
                _deaths.Add(death);
                return;
            }
            if ((syncedHealth ?? 1f) <= 0f)
            {
                Kill(death.Attackers, death.Name, death.Time);
                death.Counted = true;
            }
            if (!death.Counted || fromServer)
                _diag(death.Counted ? "destroy-server-kill" : "destroy-nokill", Prefab(mob), death.Attackers,
                    $"health {syncedHealth ?? -1f:0.#} max {maxHealth ?? -1f:0.#} {info}".TrimEnd(), pos);
            _deaths.Add(death);
        }

        // A ragdoll appeared (every death of a kind with one spawns it): the creature it belongs to, its level, where.
        // ragdoll: its own prefab (not used yet: several kinds can share one).
        internal void Ragdoll(float t, string uid, string creature, int level, Vec pos, string ragdoll = null)
        {
            if (!_seenCorpses.Add(uid))
                return;
            _corpses.Add(new Corpse { Pos = pos, Time = t, Creature = creature, Level = level });
        }

        // Every second: settle ragdolls against the deletions seen around them. players: every online player now.
        internal void Tick(float now, List<PlayerState> players)
        {
            Remember(players, all: true);
            for (var k = _corpses.Count - 1; k >= 0; k--)
            {
                var corpse = _corpses[k];
                if (now - corpse.Time < SettleSeconds)
                    continue;
                _corpses.RemoveAt(k);
                Death match = null;
                foreach (var d in _deaths)
                    if (Math.Abs(d.Time - corpse.Time) <= MatchSeconds && Vec.Distance(d.Pos, corpse.Pos) <= MatchRange
                        && (match == null || Vec.Distance(d.Pos, corpse.Pos) < Vec.Distance(match.Pos, corpse.Pos)))
                        match = d;
                if (match == null)
                    _diag("ragdoll-nomatch", corpse.Creature, null, $"level {corpse.Level} at {corpse.Pos.X:0},{corpse.Pos.Z:0}", corpse.Pos);
                if (match != null && match.Counted)
                    continue; // already a kill via its health
                var name = corpse.Level > 1 ? $"{corpse.Creature}*{corpse.Level - 1}" : corpse.Creature;
                var attackers = match?.Attackers.Count > 0 ? match.Attackers : Nearest(players, corpse.Pos);
                if (attackers.Count == 0)
                    continue;
                Kill(attackers, match?.Name ?? name, match?.Time ?? corpse.Time);
                if (match != null && match.Health > 0f)
                    Damage(attackers, match.Name, match.Health, match.Time); // the one-hit kill's damage never synced
                if (match != null)
                    match.Counted = true;
            }
            _deaths.RemoveAll(d => now - d.Time > 2 * MatchSeconds + SettleSeconds);
            if (_corpses.Count == 0 && _seenCorpses.Count > 1000)
                _seenCorpses.Clear();
        }

        // ---- attack history (Pets.cs asks too) -----------------------------------------------------------------

        // Attacks by this player in [from, to], oldest first.
        internal IEnumerable<string> Between(string player, float from, float to)
        {
            if (!_attacks.TryGetValue(player, out var list))
                yield break;
            foreach (var a in list)
                if (a.Time >= from && a.Time <= to)
                    yield return a.Weapon;
        }

        // The weapon of their latest attack up to `at`, within Keep seconds, or null.
        internal string Last(string player, float at)
        {
            if (!_attacks.TryGetValue(player, out var list))
                return null;
            for (var k = list.Count - 1; k >= 0; k--)
                if (list[k].Time <= at && at - list[k].Time <= Keep)
                    return list[k].Weapon;
            return null;
        }

        // ---- the rules -------------------------------------------------------------------------------------------

        // The attacker list's players who count: alive (a character, not dead) and within AttackerRange of the creature.
        private static List<string> Fighting(List<PlayerState> onList, Vec pos)
        {
            var names = new List<string>();
            foreach (var p in onList)
                if (p.Body && !p.Dead && Vec.Distance(p.Pos, pos) <= AttackerRange)
                    names.Add(p.Name);
            return names;
        }

        // The nearest player with a character within CreditRange (on a tie the later one in the list, as Gather.NearestPeer).
        private static List<string> Nearest(List<PlayerState> players, Vec pos)
        {
            var names = new List<string>();
            string best = null;
            var bestDistance = CreditRange;
            foreach (var p in players)
            {
                if (!p.Body)
                    continue;
                var d = Vec.Distance(p.Pos, pos);
                if (d <= bestDistance)
                {
                    best = p.Name;
                    bestDistance = d;
                }
            }
            if (best != null)
                names.Add(best);
            return names;
        }

        private void Damage(List<string> attackers, string mob, float amount, float at)
        {
            var hits = new List<(string Player, string Weapon)>();
            foreach (var p in attackers)
                foreach (var weapon in Between(p, at - HitWindow, at))
                    hits.Add((p, weapon));
            if (hits.Count == 0)
                foreach (var p in attackers)
                    hits.Add((p, WeaponOf(p, at)));
            foreach (var (p, weapon) in hits)
            {
                _add("dmg", p, mob, amount / hits.Count);
                _add("wdmg", p, weapon, amount / hits.Count);
                _add("dw", p, $"{weapon}>{mob}", amount / hits.Count);
            }
        }

        private void Kill(List<string> attackers, string mob, float at)
        {
            foreach (var p in attackers)
            {
                var weapon = WeaponOf(p, at);
                _add("kill", p, mob, 1);
                _add("wkill", p, weapon, 1);
                _add("kw", p, $"{weapon}>{mob}", 1);
            }
        }

        // The weapon of their last attack, else what they hold — hands are empty while eating, switching or sheathed.
        private string WeaponOf(string player, float at) =>
            Last(player, at) ?? (_held.TryGetValue(player, out var held) && held != null ? held : "Unarmed");

        // What each player holds, as last seen. all: the list is every online player — whoever isn't in it has left and
        // holds nothing ("Unarmed", as the live lookup gave for a player without a character).
        private void Remember(List<PlayerState> players, bool all)
        {
            if (players == null)
                return;
            if (all)
                _held.Clear();
            foreach (var p in players)
                _held[p.Name] = p.Body ? p.Held : null;
        }

        private static string Prefab(string mob)
        {
            var star = mob.IndexOf('*');
            return star < 0 ? mob : mob.Substring(0, star);
        }
    }
}
