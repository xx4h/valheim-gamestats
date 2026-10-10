// A recording of everything the combat logic is told, for replaying a real session through CombatCore offline
// (tests/plugin: traces). Off unless the config says so (Debug / Trace): a session with fights writes a few MB.
//
// One JSON object per line in BepInEx/gamestats/trace/<UTC day>.jsonl, one per CombatCore call, in call order:
//   {"k":"attack","t":12.5,"p":"Ragnar","w":"SwordIron"}
//   {"k":"player","t":12.6,"p":"Ragnar","b":100,"a":80,"mb":120,"ma":120}
//   {"k":"health","t":13.1,"u":"123:45","m":"Troll*1","x":1,"y":2,"z":3,"b":600,"a":540,"l":[…players…]}
//   {"k":"destroy","t":14,"u":"123:45","m":"Troll*1","tamed":false,"x":…,"h":0,"mh":600,"l":[…],"ps":[…],"srv":false}
//   {"k":"ragdoll","t":14.2,"u":"124:9","c":"Troll","lv":2,"x":…,"r":"Troll_ragdoll"}
//   {"k":"tick","t":15,"ps":[…]}
//   {"k":"out","e":"dmg","p":"Ragnar","i":"Troll*1","n":60}      — what CombatCore made of it
// and the facts CombatCore doesn't use (yet), which replay skips (CombatFacts.cs says what each is):
//   {"k":"meta","v":2,"noragdoll":["Seeker",…],"ragdolls":{"Goblin_ragdoll":["Goblin","GoblinArcher"]},
//    "cost":{"StaffSkeleton/staff_summon":{"f":0,"p":40}},"drops":{"Tick":{"GiantBloodSack":1}},
//    "timed":["Charred_Twitcher_Summoned"],"reach":{"Skeleton_Friendly/attack_bow":30}}
//   {"k":"trig","t":…,"u":…,"m":"Skeleton_Friendly","tr":"attack","fol":"Ragnar","tamed":true,"own":…,"x":…,
//    "rh":"<right-hand item>","lh":"<left-hand item>"}
//   {"k":"hit","t":…,"u":…,"m":"Troll*1","tamed":false,"own":…,"from":"Ragnar","att":"…","am":"player:Ragnar",
//    "d":{"slash":45,"fire":10},"ht":"PlayerHit","se":"Burning","sk":"Swords","sl":35,"il":3,"bs":3,"x":…}
//   {"k":"killnote","t":…,"from":"Ragnar","to":"Astrid","kind":"$enemy_troll","boss":0,"n":2}
//   {"k":"rise","t":…,"u":…,"m":…,"tamed":false,"b":300,"a":340}
//   {"k":"pethp","t":…,"u":…,"m":…,"fol":"Ragnar","b":400,"a":320}
//   {"k":"owner","t":…,"u":…,"m":…,"was":123,"now":456}
//   {"k":"drop","t":…,"u":…,"i":"TrophySeeker","n":1,"own":…,"x":…}
// "destroy" also carries "own" (its owner), "from" (who deleted it) and "fol" (its follow target).
// A player: {"n":"Ragnar","b":true,"d":false,"x":…,"y":…,"z":…,"h":"SwordIron"} ("h" null: no character).
// Times are the server's Time.time (seconds since it started); "h" / "mh" null: not in the creature's state.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace ValheimGamestats
{
    internal static class CombatTrace
    {
        internal static bool Enabled;
        internal static Action<string> Warn = _ => { };  // Events.Warn in the game; no game types here (tests/plugin compiles this)
        private static string _dir;
        private static string _day;
        private static StreamWriter _out;

        internal static void Init(string root)
        {
            _out?.Dispose();
            _out = null;
            _dir = Path.Combine(root, "gamestats", "trace");
        }

        internal static void Close()
        {
            _out?.Dispose();
            _out = null;
        }

        internal static void Attack(float t, string player, string weapon) =>
            Write(new StringBuilder("{\"k\":\"attack\"").Num("t", t).Str("p", player).Str("w", weapon));

        internal static void Player(float t, string player, float before, float after, float maxBefore, float maxAfter) =>
            Write(new StringBuilder("{\"k\":\"player\"").Num("t", t).Str("p", player).Num("b", before).Num("a", after).Num("mb", maxBefore)
                .Num("ma", maxAfter));

        internal static void Health(float t, string uid, string mob, Vec pos, float before, float after, List<PlayerState> onList) =>
            Write(new StringBuilder("{\"k\":\"health\"").Num("t", t).Str("u", uid).Str("m", mob).Pos(pos).Num("b", before)
                .Num("a", after).Players("l", onList));

        internal static void Destroyed(float t, string uid, string mob, bool tamed, Vec pos, float? health, float? maxHealth,
            List<PlayerState> onList, List<PlayerState> players, bool fromServer, long owner = 0, string from = null, string follow = null) =>
            Write(new StringBuilder("{\"k\":\"destroy\"").Num("t", t).Str("u", uid).Str("m", mob).Bool("tamed", tamed).Pos(pos)
                .Num("h", health).Num("mh", maxHealth).Players("l", onList).Players("ps", players).Bool("srv", fromServer)
                .Num("own", owner).Str("from", from).Str("fol", follow));

        internal static void Meta(List<string> noRagdoll, CombatMeta meta)
        {
            var sb = new StringBuilder("{\"k\":\"meta\"").Num("v", 2).Key("noragdoll").Append('[');
            for (var i = 0; i < noRagdoll.Count; i++)
                sb.Append(i > 0 ? "," : "").Append(Quote(noRagdoll[i]));
            sb.Append(']').Key("ragdolls").Append('{');
            var n = 0;
            foreach (var kv in meta.Ragdolls)
            {
                sb.Append(n++ > 0 ? "," : "").Append(Quote(kv.Key)).Append(":[");
                for (var c = 0; c < kv.Value.Count; c++)
                    sb.Append(c > 0 ? "," : "").Append(Quote(kv.Value[c]));
                sb.Append(']');
            }
            sb.Append('}').Key("cost").Append('{');
            n = 0;
            foreach (var kv in meta.Costs)
                sb.Append(n++ > 0 ? "," : "").Append(Quote(kv.Key)).Append(":{\"f\":").Append(F(kv.Value.Flat)).Append(",\"p\":")
                    .Append(F(kv.Value.Percent)).Append('}');
            sb.Append('}').Key("drops").Append('{');
            n = 0;
            foreach (var kv in meta.Drops)
            {
                sb.Append(n++ > 0 ? "," : "").Append(Quote(kv.Key)).Append(":{");
                var d = 0;
                foreach (var item in kv.Value)
                    sb.Append(d++ > 0 ? "," : "").Append(Quote(item.Key)).Append(':').Append(F(item.Value));
                sb.Append('}');
            }
            sb.Append('}').Key("timed").Append('[');
            n = 0;
            foreach (var kind in meta.Timed)
                sb.Append(n++ > 0 ? "," : "").Append(Quote(kind));
            sb.Append(']').Key("reach").Append('{');
            n = 0;
            foreach (var kv in meta.Reach)
                sb.Append(n++ > 0 ? "," : "").Append(Quote(kv.Key)).Append(':').Append(F(kv.Value));
            Write(sb.Append('}'));
        }

        private static string F(float v) => ((double)v).ToString("R", CultureInfo.InvariantCulture);

        internal static void Trigger(float t, string uid, string who, string trigger, string follow, bool tamed, long owner, Vec pos,
            string right = null, string left = null) =>
            Write(new StringBuilder("{\"k\":\"trig\"").Num("t", t).Str("u", uid).Str("m", who).Str("tr", trigger).Str("fol", follow)
                .Bool("tamed", tamed).Num("own", owner).Pos(pos).Str("rh", right).Str("lh", left));

        internal static void Hit(float t, string uid, string who, bool tamed, long owner, string from, string attacker, string attackerWho,
            List<(string Type, float Value)> damage, string hitType, string statusEffect, string skill, float skillLevel, int itemLevel,
            float backstab, Vec point)
        {
            var sb = new StringBuilder("{\"k\":\"hit\"").Num("t", t).Str("u", uid).Str("m", who).Bool("tamed", tamed).Num("own", owner)
                .Str("from", from).Str("att", attacker).Str("am", attackerWho).Key("d").Append('{');
            for (var i = 0; i < damage.Count; i++)
                sb.Append(i > 0 ? "," : "").Append(Quote(damage[i].Type)).Append(':')
                    .Append(((double)damage[i].Value).ToString("R", CultureInfo.InvariantCulture));
            Write(sb.Append('}').Str("ht", hitType).Str("se", statusEffect).Str("sk", skill).Num("sl", skillLevel).Num("il", itemLevel)
                .Num("bs", backstab).Pos(point));
        }

        internal static void KillNote(float t, string from, string to, string kind, int boss, int attackers) =>
            Write(new StringBuilder("{\"k\":\"killnote\"").Num("t", t).Str("from", from).Str("to", to).Str("kind", kind).Num("boss", boss)
                .Num("n", attackers));

        internal static void Rise(float t, string uid, string who, bool tamed, float before, float after) =>
            Write(new StringBuilder("{\"k\":\"rise\"").Num("t", t).Str("u", uid).Str("m", who).Bool("tamed", tamed).Num("b", before)
                .Num("a", after));

        internal static void PetHealth(float t, string uid, string who, string follow, float before, float after) =>
            Write(new StringBuilder("{\"k\":\"pethp\"").Num("t", t).Str("u", uid).Str("m", who).Str("fol", follow).Num("b", before)
                .Num("a", after));

        internal static void Owner(float t, string uid, string who, long was, long now) =>
            Write(new StringBuilder("{\"k\":\"owner\"").Num("t", t).Str("u", uid).Str("m", who).Num("was", was).Num("now", now));

        internal static void Drop(float t, string uid, string item, int stack, long owner, Vec pos) =>
            Write(new StringBuilder("{\"k\":\"drop\"").Num("t", t).Str("u", uid).Str("i", item).Num("n", stack).Num("own", owner).Pos(pos));

        internal static void Ragdoll(float t, string uid, string creature, int level, Vec pos, string ragdoll = null) =>
            Write(new StringBuilder("{\"k\":\"ragdoll\"").Num("t", t).Str("u", uid).Str("c", creature).Num("lv", level).Pos(pos)
                .Str("r", ragdoll));

        internal static void Tick(float t, List<PlayerState> players)
        {
            Write(new StringBuilder("{\"k\":\"tick\"").Num("t", t).Players("ps", players));
            try
            {
                _out?.Flush(); // once a second: a crash loses at most that
            }
            catch (IOException)
            {
            }
        }

        internal static void Out(string e, string p, string i, double n) =>
            Write(new StringBuilder("{\"k\":\"out\"").Str("e", e).Str("p", p).Str("i", i).Num("n", n));

        private static void Write(StringBuilder line)
        {
            if (!Enabled || _dir == null)
                return;
            try
            {
                var day = DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                if (_out == null || day != _day)
                {
                    _out?.Dispose();
                    Directory.CreateDirectory(_dir);
                    _out = new StreamWriter(Path.Combine(_dir, day + ".jsonl"), true, new UTF8Encoding(false));
                    _day = day;
                }
                _out.Write(line.Append('}').Append('\n').ToString());
            }
            catch (Exception e)
            {
                Enabled = false; // a full disk must not take the stats down with it
                Warn(e.Message);
            }
        }

        // ---- a minimal JSON writer: the game's Mono has no serializer we can count on ------------------------------

        private static StringBuilder Key(this StringBuilder sb, string key) => sb.Append(",\"").Append(key).Append("\":");

        private static StringBuilder Str(this StringBuilder sb, string key, string value)
        {
            sb.Key(key);
            if (value == null)
                return sb.Append("null");
            sb.Append('"');
            foreach (var c in value)
            {
                if (c == '"' || c == '\\')
                    sb.Append('\\').Append(c);
                else if (c < ' ')
                    sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else
                    sb.Append(c);
            }
            return sb.Append('"');
        }

        // A JSON string on its own (array items, object keys): Str's escaping without the key.
        private static string Quote(string value) => new StringBuilder().Str("x", value).ToString().Substring(5);

        private static StringBuilder Num(this StringBuilder sb, string key, double? value) =>
            value == null || double.IsNaN(value.Value) || double.IsInfinity(value.Value)
                ? sb.Key(key).Append("null")
                : sb.Key(key).Append(value.Value.ToString("R", CultureInfo.InvariantCulture));

        private static StringBuilder Num(this StringBuilder sb, string key, long value) =>
            sb.Key(key).Append(value.ToString(CultureInfo.InvariantCulture)); // ids: exact, not through a double

        private static StringBuilder Bool(this StringBuilder sb, string key, bool value) => sb.Key(key).Append(value ? "true" : "false");

        private static StringBuilder Pos(this StringBuilder sb, Vec p) => sb.Num("x", p.X).Num("y", p.Y).Num("z", p.Z);

        private static StringBuilder Players(this StringBuilder sb, string key, List<PlayerState> players)
        {
            sb.Key(key).Append('[');
            for (var i = 0; i < (players?.Count ?? 0); i++)
            {
                var p = players[i];
                if (i > 0)
                    sb.Append(',');
                sb.Append('{').Append("\"n\":");
                sb.Append(Quote(p.Name));
                sb.Bool("b", p.Body).Bool("d", p.Dead).Pos(p.Pos).Str("h", p.Body ? p.Held : null).Append('}');
            }
            return sb.Append(']');
        }
    }
}
