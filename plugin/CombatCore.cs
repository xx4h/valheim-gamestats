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
    // need to know about creatures and items (docs/ATTRIBUTION.md). CombatCore uses the health costs, ragdolls, loot tables and timed kinds so far.
    internal class CombatMeta
    {
        public readonly Dictionary<string, List<string>> Ragdolls = new Dictionary<string, List<string>>(); // ragdoll → creature kinds
        public readonly Dictionary<string, Dictionary<string, float>> Drops = new Dictionary<string, Dictionary<string, float>>(); // creature → item → chance
        public readonly HashSet<string> Timed = new HashSet<string>(); // deleted on a timer (enemy summons)
        public readonly HashSet<string> NoRagdoll = new HashSet<string>(); // kinds whose death leaves none (loot at death)
        public readonly Dictionary<string, (float Flat, float Percent)> Costs = new Dictionary<string, (float, float)>(); // "Item/animation" → health cost
        public readonly Dictionary<string, float> Reach = new Dictionary<string, float>(); // "Creature/animation" → reach (m)
        public readonly Dictionary<string, string> Names = new Dictionary<string, string>(); // creature prefab → its name token ($enemy_greyling)
        public readonly Dictionary<string, (bool Ranged, float Reach, bool Harmful)> Weapons =
            new Dictionary<string, (bool, float, bool)>(); // player weapons: projectile or melee, melee reach, does damage at all
    }

    internal class CombatCore
    {
        internal const float MatchRange = 4f;
        internal const float AttackerRange = 60f; // bow range, roughly
        internal const float HitWindow = 3f;      // swing starts → hit lands → its health sync arrives; arrows fly ~1-2 s
        internal const float MatchSeconds = 6f;
        internal const float SettleSeconds = 3f;  // let the deletion of a ragdoll's mob arrive first
        internal const float Keep = 30f;          // seconds of attack history per player
        internal const float LootRange = 3f;      // a corpse-less death's loot drops at its centre
        internal const float LootSeconds = 2f;    // … in the same frame as the death; its deletion and the item arrive close together
        internal const float HurtSeconds = 10f;
        internal const float NoteSeconds = 3f;    // a kill note and its creature's deletion: sent in the same frame, routed apart
        internal const float MeleeSeconds = 1.5f; // a swing lands well within this
        internal const float MeleeMargin = 4f;    // positions are centres; players lunge
        internal const float MeleeReach = 3f;     // a weapon the meta doesn't know   // a deletion this soon after damage that no signal explains: `gone`
        internal const float CostSeconds = 2f;    // a health-cost attack's cost arrives in the next sync, well within this
        internal const float CostSkillMin = 0.67f; // cost × (1 − 0.33 × skill factor): at skill 100 a third less
        internal const float CostFactorDefault = (1f + CostSkillMin) / 2f; // until a clean cost showed the player's own

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
            public string Kind;     // its prefab, without stars
            public long By;         // the client that deleted it (and spawned its loot)
            public bool Hurt;       // damaged within HurtSeconds before its deletion
            public bool Decided;    // its loot looked for / reported as `gone`
            public string Uid;
            public string Signal;   // what says it died: "health 0", "ragdoll", "loot"; credited SettleSeconds after it died
            public bool Credited;
            public List<PlayerState> Players; // every online player when it was deleted (for the attack evidence)
            public List<string> Listed;  // its attacker list as it was (also the dead and far away): for the investigation log
        }

        private class Corpse
        {
            public Vec Pos;
            public float Time;
            public string Creature;
            public int Level;
            public string Ragdoll;  // its prefab: Meta.Ragdolls says which kinds it can belong to
        }

        private readonly List<Death> _deaths = new List<Death>();
        private readonly List<Corpse> _corpses = new List<Corpse>();
        private readonly HashSet<string> _seenCorpses = new HashSet<string>();
        private readonly Dictionary<string, List<string>> _killers = new Dictionary<string, List<string>>(); // at health 0
        private readonly Dictionary<string, List<(float Time, string Weapon)>> _attacks =
            new Dictionary<string, List<(float, string)>>();
        private readonly Dictionary<string, string> _held = new Dictionary<string, string>();
        private readonly Dictionary<string, float> _hurt = new Dictionary<string, float>(); // creature uid → its latest drop
        private readonly List<(float Time, string Item, long By, Vec Pos)> _loot = new List<(float, string, long, Vec)>();
        private readonly List<(float Time, long From, string To, string Kind)> _notes = new List<(float, long, string, string)>();
        private readonly Dictionary<string, HashSet<string>> _hitBy = new Dictionary<string, HashSet<string>>(); // creature uid → players with a routed hit
        private readonly HashSet<(string Player, float Time)> _usedAttacks = new HashSet<(string, float)>(); // evidence for one death each
        private HashSet<string> _withRagdoll = new HashSet<string>(); // kinds whose death spawns a ragdoll (Meta)
        private readonly Dictionary<string, List<(float Time, string Weapon, float Flat, float Percent)>> _costs =
            new Dictionary<string, List<(float, string, float, float)>>(); // health-cost attacks whose cost hasn't shown yet
        private readonly Dictionary<string, float> _costFactor = new Dictionary<string, float>(); // per player: 1 − 0.33 × skill factor

        private CombatMeta _meta = new CombatMeta();

        // A death counted (credited or unaccounted): its name and the health it still had when deleted — loss that never
        // synced as a drop (one-hit kills, the last blow). For coverage: lost = synced drops + this.
        internal Action<string, float> Died = (name, remaining) => { };

        // ---- inputs ----------------------------------------------------------------------------------------------

        // The prefabs' facts, once.
        internal void Meta(CombatMeta meta)
        {
            _meta = meta ?? new CombatMeta();
            _withRagdoll = new HashSet<string>();
            foreach (var kinds in _meta.Ragdolls.Values)
                _withRagdoll.UnionWith(kinds);
        }

        // A summon or commanded tame (`follow`: its player) started an attack (not used yet).
        internal void Summon(float t, string uid, string kind, string animation, string follow, Vec pos)
        {
        }

        // A new item object; `by`: the client that created it (its uid's user part). Loot of a corpse-less death (Tick).
        internal void Loot(float t, string uid, string item, long by, Vec pos)
        {
            _loot.RemoveAll(l => t - l.Time > 2 * LootSeconds + SettleSeconds);
            if (_loot.Count < 1000)
                _loot.Add((t, item, by, pos));
        }

        // The game's own kill note (RPC_RegisterKill): the client that ran a creature tells a player on its attacker list
        // they killed it — only routed by the server, sent in the same frame as the death. kind: the creature's name token.
        internal void KillNote(float t, long from, string to, string kind)
        {
            _notes.RemoveAll(n => t - n.Time > 2 * NoteSeconds + SettleSeconds);
            if (_notes.Count < 1000 && !string.IsNullOrEmpty(to))
                _notes.Add((t, from, to, kind));
        }

        // A hit by a player on a creature that another client runs (RPC_Damage routed by the server): exact evidence that
        // they hit it, even when the creature dies before its attacker list syncs.
        internal void Hit(float t, string uid, string player, float damage)
        {
            if (string.IsNullOrEmpty(player) || damage <= 0f)
                return;
            if (_hitBy.Count > 5000)
                _hitBy.Clear();
            if (!_hitBy.TryGetValue(uid, out var players))
                _hitBy[uid] = players = new HashSet<string>();
            players.Add(player);
        }

        // A player started an attack with this weapon (Attacks.cs: the animation trigger). An attack that costs health
        // (blood magic: Meta.Costs by weapon and animation) takes it in its first frame: the player's next health drop.
        internal void Attack(float t, string player, string weapon, string animation = null)
        {
            if (animation != null && _meta.Costs.TryGetValue(weapon + "/" + animation, out var cost))
            {
                if (!_costs.TryGetValue(player, out var pending))
                    _costs[player] = pending = new List<(float, string, float, float)>();
                pending.RemoveAll(c => t - c.Time > CostSeconds);
                pending.Add((t, weapon, cost.Flat, cost.Percent));
            }
            if (!_attacks.TryGetValue(player, out var list))
                _attacks[player] = list = new List<(float, string)>();
            list.RemoveAll(a => t - a.Time > Keep);
            list.Add((t, weapon));
        }

        // A player's health changed: damage taken and one hit per drop; a drop to exactly the new, lower max health is
        // food wearing off. A drop that is the cost of their own health-cost attack (blood magic) is `cost`, not damage:
        // the game takes (flat + health × percent / 100) × (1 − 0.33 × skill factor), at most health − 1; the skill
        // isn't on the server, so anything from a third less up to the full cost is it. More than that is a hit merged
        // into the same sync: the cost at the player's own factor (learned from clean costs), the rest damage. Less is
        // something else (a poison tick); the cost is still to come. Returns the damage taken (0: not damage).
        internal float PlayerHealth(string player, float before, float after, float maxBefore, float maxAfter, float t = 0f)
        {
            after = Math.Max(0f, after);
            var lost = before - after;
            if (lost <= 0.01f)
                return 0f;
            if (maxAfter < maxBefore - 0.01f && Math.Abs(after - maxAfter) < 0.01f)
                return 0f;
            if (_costs.TryGetValue(player, out var pending))
            {
                pending.RemoveAll(c => t - c.Time > CostSeconds);
                if (pending.Count > 0)
                {
                    var c = pending[0];
                    var full = c.Flat + before * c.Percent / 100f;
                    var margin = Math.Max(0.5f, 0.02f * full);
                    var capped = after <= 1f + margin && full * CostSkillMin >= before - 1f - margin; // at most health − 1
                    if (capped || (lost >= full * CostSkillMin - margin && lost <= full + margin))
                    {
                        pending.RemoveAt(0);
                        if (!capped && full > 0f)
                            _costFactor[player] = Math.Min(1f, lost / full);
                        _add("cost", player, c.Weapon, lost);
                        return 0f;
                    }
                    if (lost > full + margin)
                    {
                        pending.RemoveAt(0);
                        var cost = Math.Min(before - 1f, full * (_costFactor.TryGetValue(player, out var f) ? f : CostFactorDefault));
                        _add("cost", player, c.Weapon, cost);
                        lost -= cost;
                    }
                }
            }
            _add("taken", player, "", lost);
            _add("hit", player, "", 1);
            return lost;
        }

        // An untamed creature's health changed. onList: the online players on its attacker list, as they are now.
        internal void CreatureHealth(float t, string uid, string mob, Vec pos, float before, float after, List<PlayerState> onList)
        {
            Remember(onList, all: false);
            var afterClamped = Math.Max(0f, after);
            var lost = before - afterClamped;
            if (lost <= 0.01f)
                return;
            if (_hurt.Count > 5000)
                _hurt.Clear();
            _hurt[uid] = t;
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
                Kind = Prefab(mob),
                By = by,
                Listed = Names(onList),
                Uid = uid,
                Players = players ?? new List<PlayerState>(),
                Hurt = _hurt.TryGetValue(uid, out var hurt) && t - hurt <= HurtSeconds,
            };
            _killers.Remove(uid);
            _hurt.Remove(uid);
            if (tamed)
            {
                death.Counted = true; // a pet: no kill, but its ragdoll must find this death
                _deaths.Add(death);
                return;
            }
            if ((syncedHealth ?? 1f) <= 0f)
            {
                death.Signal = "health 0";
                death.Counted = true;
            }
            if (!death.Counted || fromServer)
                _diag(death.Counted ? "destroy-server-kill" : "destroy-nokill", Prefab(mob), death.Attackers,
                    $"health {syncedHealth ?? -1f:0.#} max {maxHealth ?? -1f:0.#} {info}".TrimEnd(), pos);
            _deaths.Add(death);
        }

        // A ragdoll appeared (every death of a kind with one spawns it): the creature it belongs to, its level, where.
        // ragdoll: its own prefab — several kinds can share one; it only matches deaths of those (Meta.Ragdolls).
        internal void Ragdoll(float t, string uid, string creature, int level, Vec pos, string ragdoll = null)
        {
            if (!_seenCorpses.Add(uid))
                return;
            _corpses.Add(new Corpse { Pos = pos, Time = t, Creature = creature, Level = level, Ragdoll = ragdoll });
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
                // only a death of a kind this ragdoll belongs to (a Troll's ragdoll is no Greyling's death); a ragdoll the
                // meta doesn't know (older traces) matches any kind, as before
                var kinds = corpse.Ragdoll != null && _meta.Ragdolls.TryGetValue(corpse.Ragdoll, out var own) ? own : null;
                foreach (var d in _deaths)
                    if (Math.Abs(d.Time - corpse.Time) <= MatchSeconds && Vec.Distance(d.Pos, corpse.Pos) <= MatchRange
                        && (kinds == null || kinds.Contains(d.Kind))
                        && (match == null || Vec.Distance(d.Pos, corpse.Pos) < Vec.Distance(match.Pos, corpse.Pos)))
                        match = d;
                if (match == null)
                    _diag("ragdoll-nomatch", corpse.Creature, null, $"level {corpse.Level} at {corpse.Pos.X:0},{corpse.Pos.Z:0}", corpse.Pos);
                if (match != null && match.Counted)
                    continue; // already a kill via its health
                if (match == null)
                {
                    // a death whose deletion never showed: nobody to credit, and its kind only as far as the ragdoll
                    // tells (a shared one: every kind it can belong to, "Goblin/GoblinArcher")
                    var kind = kinds == null ? corpse.Creature : string.Join("/", kinds);
                    var who = corpse.Level > 1 ? $"{kind}*{corpse.Level - 1}" : kind;
                    Died(who, 0f); // its health at death unknown
                    Unaccounted(who, "ragdoll, no deletion", null, corpse.Pos);
                    continue;
                }
                match.Signal = "ragdoll";
                match.Counted = true;
            }
            foreach (var d in _deaths)
                if (!d.Counted && !d.Decided && now - d.Time >= SettleSeconds && Corpseless(d.Kind))
                    Settle(d, now);
            foreach (var d in _deaths)
                if (d.Signal != null && !d.Credited && now - d.Time >= SettleSeconds)
                    Credit(d);
            foreach (var d in _deaths)
                if (now - d.Time > 2 * MatchSeconds + SettleSeconds && !d.Counted && !d.Decided)
                    Gone(d); // a kind with a ragdoll: none came
            _deaths.RemoveAll(d => now - d.Time > 2 * MatchSeconds + SettleSeconds);
            if (_corpses.Count == 0 && _seenCorpses.Count > 1000)
                _seenCorpses.Clear();
        }

        // A kind whose death leaves no ragdoll: the meta says so, or knows the ragdolls and this kind has none.
        private bool Corpseless(string kind) =>
            _meta.NoRagdoll.Contains(kind) || (_meta.Ragdolls.Count > 0 && !_withRagdoll.Contains(kind));

        // A corpse-less creature deleted with health left: its own loot (from its drop table, created by the client that
        // deleted it, at its place, right then) says it died — the kill, and its last health as the damage that never
        // synced. A creature deleted on a timer (enemy summons) needs health 0. Nothing: `gone`.
        private void Settle(Death d, float now)
        {
            d.Decided = true;
            if (!_meta.Timed.Contains(d.Kind) && _meta.Drops.TryGetValue(d.Kind, out var table) && d.By != 0
                && _loot.Exists(l => l.By == d.By && table.ContainsKey(l.Item) && Vec.Distance(l.Pos, d.Pos) <= LootRange
                                     && l.Time - d.Time >= -LootSeconds / 2 && l.Time - d.Time <= LootSeconds))
            {
                d.Signal = "loot";
                d.Counted = true;
                Credit(d);
                return;
            }
            Gone(d);
        }

        // A death, credited: the players on its attacker list (alive, near), plus those the other evidence names — the game's
        // kill note to them, a routed hit of theirs, their own damaging attack just before in reach of it. Nobody: unaccounted.
        // Its last health (a one-hit kill's, never synced) goes to them as damage.
        private void Credit(Death d)
        {
            d.Credited = true;
            var killers = new List<string>(d.Attackers);
            void Add(string p)
            {
                if (!killers.Contains(p))
                    killers.Add(p);
            }
            foreach (var p in Noted(d))
                Add(p);
            if (_hitBy.TryGetValue(d.Uid ?? "", out var hitters))
                foreach (var p in Fighting(d.Players.FindAll(x => hitters.Contains(x.Name)), d.Pos))
                    Add(p);
            foreach (var p in Struck(d))
                Add(p);
            _hitBy.Remove(d.Uid ?? "");
            Kill(killers, d.Name, d.Time, d.Signal, d);
            if (killers.Count > 0 && d.Health > 0f)
                Damage(killers, d.Name, d.Health, d.Time);
        }

        // The players the game's kill notes name for this death: from the client that deleted it, of its kind, at the time.
        private List<string> Noted(Death d)
        {
            var names = new List<string>();
            for (var i = _notes.Count - 1; i >= 0; i--)
            {
                var n = _notes[i];
                if (n.From == d.By && d.By != 0 && Math.Abs(n.Time - d.Time) <= NoteSeconds && IsKind(n.Kind, d.Kind))
                {
                    if (!names.Contains(n.To))
                        names.Add(n.To);
                    _notes.RemoveAt(i); // a note credits one death
                }
            }
            return names;
        }

        // A kill note's name token is this creature prefab's: by the meta, else (older traces) by its name.
        private bool IsKind(string token, string kind) =>
            _meta.Names.TryGetValue(kind, out var name) ? name == token : token.EndsWith("_" + kind.ToLowerInvariant());

        // The players whose own damaging attack just before the death was in reach of it: melee within MeleeSeconds and the
        // weapon's reach (+ MeleeMargin), ranged within HitWindow and AttackerRange. One attack is evidence for one death.
        private List<string> Struck(Death d)
        {
            var names = new List<string>();
            foreach (var p in d.Players)
            {
                if (!p.Body || p.Dead || !_attacks.TryGetValue(p.Name, out var list))
                    continue;
                var distance = Vec.Distance(p.Pos, d.Pos);
                for (var k = list.Count - 1; k >= 0; k--)
                {
                    var (time, weapon) = list[k];
                    if (time > d.Time || d.Time - time > HitWindow || _usedAttacks.Contains((p.Name, time)))
                        continue;
                    var w = _meta.Weapons.TryGetValue(weapon, out var known) ? known : (Ranged: false, Reach: MeleeReach, Harmful: true);
                    if (!w.Harmful)
                        continue;
                    var reach = w.Ranged ? AttackerRange : w.Reach + MeleeMargin;
                    if ((w.Ranged || d.Time - time <= MeleeSeconds) && distance <= reach)
                    {
                        if (_usedAttacks.Count > 5000)
                            _usedAttacks.Clear();
                        _usedAttacks.Add((p.Name, time));
                        names.Add(p.Name);
                        break;
                    }
                }
            }
            return names;
        }

        // A deletion right after damage that no death signal explains: maybe a kill missed, so it's counted, not dropped.
        private void Gone(Death d)
        {
            d.Decided = true;
            if (d.Hurt)
                _add("gone", null, d.Name, 1);
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

        // A death with no evidence for who killed it — nobody on its attacker list alive and near, no summon of anyone's
        // in reach: `ukill`, with no player (the stat "Unaccounted kills"), and a line in the server log with what was
        // known, to investigate (docs/ATTRIBUTION.md). Never guessed from who happened to be nearby.
        private void Unaccounted(string mob, string signal, List<string> listed, Vec? pos)
        {
            _add("ukill", null, mob, 1);
            var on = listed == null ? "unknown (no deletion)" : listed.Count == 0 ? "empty" : string.Join(",", listed);
            _diag("unaccounted", mob, null, $"signal={signal} list={on}", pos);
        }

        private static List<string> Names(List<PlayerState> players)
        {
            var names = new List<string>();
            foreach (var p in players ?? new List<PlayerState>())
                names.Add(p.Name + (p.Dead ? "(dead)" : p.Body ? "" : "(no character)"));
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

        private void Kill(List<string> attackers, string mob, float at, string signal = null, Death death = null)
        {
            Died(mob, death?.Health ?? 0f);
            if (attackers.Count == 0)
            {
                Unaccounted(mob, signal, death?.Listed, death?.Pos);
                return;
            }
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
