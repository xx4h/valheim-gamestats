// Replays a combat trace (plugin/CombatTrace.cs: one JSON object per CombatCore call) through a fresh CombatCore:
// what it makes of a recorded session, to compare with what the plugin made of it then ("out" lines) — or, after a
// change to the rules, to see exactly what changes.
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using ValheimGamestats;

static class Replay
{
    // (what the core makes of the trace now, what the plugin recorded then): (event, player, object) → sum
    internal static (Dictionary<(string, string, string), double> Now, Dictionary<(string, string, string), double> Then) Run(
        IEnumerable<string> lines)
    {
        var now = new Dictionary<(string, string, string), double>();
        var then = new Dictionary<(string, string, string), double>();
        void Add(Dictionary<(string, string, string), double> d, string e, string p, string i, double n)
        {
            if (string.IsNullOrEmpty(p) && e != "ukill") // ukill: no player by nature
                return;
            p ??= "";
            d.TryGetValue((e, p, i), out var have);
            d[(e, p, i)] = have + n;
        }
        var all = lines.Where(l => !string.IsNullOrWhiteSpace(l)).Select(l => JsonDocument.Parse(l).RootElement).ToList();
        // older traces: kill notes name their sender, deletions name and number theirs — map one to the other
        var clients = new Dictionary<string, long>();
        foreach (var j in all.Where(j => S(j, "k") == "destroy" && Has(j, "from") && Has(j, "own")))
            clients[S(j, "from")] = j.GetProperty("own").GetInt64();
        var weaponsSeen = new HashSet<string>(all.Where(j => S(j, "k") == "attack").Select(j => S(j, "w")));
        var core = new CombatCore((e, p, i, n) => Add(now, e, p, i, n));
        Remaining.Clear();
        core.Died = (name, remaining) => Remaining[name] = Remaining.GetValueOrDefault(name) + remaining;
        // an attack line is followed by its trigger line (the animation, for health costs): hold it one line
        (float T, string P, string W)? held = null;
        var last = 0f; // the latest time seen: player lines of older traces have none
        void Flush(string animation)
        {
            if (held is var (t, p, w))
                core.Attack(t, p, w, animation);
            held = null;
        }
        foreach (var j in all)
        {
            var kind = j.GetProperty("k").GetString();
            if (Has(j, "t"))
                last = F(j, "t");
            if (held != null)
                Flush(kind == "trig" && S(j, "m") == "player:" + held.Value.P && F(j, "t") == held.Value.T ? S(j, "tr") : null);
            switch (kind)
            {
                case "meta":
                    core.Meta(Meta(j, weaponsSeen));
                    break;
                case "killnote":
                    core.KillNote(F(j, "t"), Has(j, "fromid") && j.GetProperty("fromid").GetInt64() != 0 ? j.GetProperty("fromid").GetInt64()
                        : clients.GetValueOrDefault(S(j, "from")), S(j, "to"), S(j, "kind"));
                    break;
                case "hit":
                    if (S(j, "am") is string am && am.StartsWith("player:"))
                        core.Hit(F(j, "t"), S(j, "u"), am.Substring(7), (float)j.GetProperty("d").EnumerateObject().Sum(d => d.Value.GetDouble()));
                    break;
                case "attack":
                    held = (F(j, "t"), S(j, "p"), S(j, "w"));
                    break;
                case "trig":
                    if (Has(j, "tamed") && j.GetProperty("tamed").GetBoolean() && S(j, "fol") != null)
                        core.Summon(F(j, "t"), S(j, "u"), Prefab(S(j, "m")), S(j, "tr"), S(j, "fol"), Pos(j));
                    break;
                case "drop":
                    core.Loot(F(j, "t"), S(j, "u"), S(j, "i"), long.Parse(S(j, "u").Split(':')[0]), Pos(j));
                    break;
                case "player":
                    core.PlayerHealth(S(j, "p"), F(j, "b"), F(j, "a"), F(j, "mb"), F(j, "ma"), last);
                    break;
                case "health":
                    core.CreatureHealth(F(j, "t"), S(j, "u"), S(j, "m"), Pos(j), F(j, "b"), F(j, "a"), Players(j, "l"));
                    break;
                case "destroy":
                    core.Destroyed(F(j, "t"), S(j, "u"), S(j, "m"), j.GetProperty("tamed").GetBoolean(), Pos(j), N(j, "h"), N(j, "mh"),
                        Players(j, "l"), Players(j, "ps"), j.GetProperty("srv").GetBoolean(), by: Has(j, "own") ? j.GetProperty("own").GetInt64() : 0);
                    break;
                case "ragdoll":
                    core.Ragdoll(F(j, "t"), S(j, "u"), S(j, "c"), (int)F(j, "lv"), Pos(j), Has(j, "r") ? S(j, "r") : null);
                    break;
                case "tick":
                    core.Tick(F(j, "t"), Players(j, "ps"));
                    break;
                case "out":
                    Add(then, S(j, "e"), S(j, "p"), S(j, "i"), j.GetProperty("n").GetDouble());
                    break;
            }
        }
        Flush(null);
        // the trace ends: deaths still waiting for their credit (3 s) or their ragdoll get it now, as a running server would
        core.Tick(last + 2 * CombatCore.MatchSeconds + 2 * CombatCore.SettleSeconds, new List<PlayerState>());
        return (now, then);
    }

    // The invariants of docs/ATTRIBUTION.md ("Checks"), on a real session, for what the core made of it (`now`):
    //   I1  every player credited with damage or a kill on a kind has evidence for it in the trace: on an attacker list
    //       of that kind, a routed hit on one, a kill note naming them for one, their own attack just before a deletion
    //       of one within reach, or a summon of theirs that attacked within 10 s and 40 m of one
    //   I3  no player has more kills of a kind than the trace has deaths of it (deletions + ragdolls of that kind)
    // and per creature kind: health lost vs damage credited to players (coverage).
    internal static (List<string> Violations, List<string> Coverage) Invariants(IEnumerable<string> lines,
        Dictionary<(string, string, string), double> now)
    {
        var listed = new HashSet<(string Player, string Kind)>();
        var deaths = new Dictionary<string, int>();
        var lost = new Dictionary<string, double>();
        var seen = new List<(float T, string Kind, Vec Pos)>();
        var summons = new List<(float T, string Player, Vec Pos)>();
        var hitters = new HashSet<(string Player, string Kind)>();
        var noted = new HashSet<(string Player, string Token)>();
        var attacks = new List<(float T, string Player)>();
        var destroys = new List<(float T, string Kind, Vec Pos, List<(string N, Vec Pos)> Players)>();
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line))
                continue;
            var j = JsonDocument.Parse(line).RootElement;
            switch (j.GetProperty("k").GetString())
            {
                case "health":
                case "destroy":
                    var kind = S(j, "m");
                    foreach (var p in j.GetProperty("l").EnumerateArray())
                        listed.Add((S(p, "n"), kind));
                    seen.Add((F(j, "t"), kind, Pos(j)));
                    if (S(j, "k") == "health")
                        lost[kind] = lost.GetValueOrDefault(kind) + System.Math.Max(0, F(j, "b") - System.Math.Max(0, F(j, "a")));
                    else if (!j.GetProperty("tamed").GetBoolean())
                    {
                        deaths[kind] = deaths.GetValueOrDefault(kind) + 1;
                        destroys.Add((F(j, "t"), kind, Pos(j),
                            j.GetProperty("ps").EnumerateArray().Where(p => p.GetProperty("b").GetBoolean()).Select(p => (S(p, "n"), Pos(p))).ToList()));
                    }
                    break;
                case "ragdoll":
                    deaths[S(j, "c")] = deaths.GetValueOrDefault(S(j, "c")) + 1;
                    break;
                case "hit":
                    if (S(j, "am") is string am && am.StartsWith("player:"))
                        hitters.Add((am.Substring(7), S(j, "m")));
                    break;
                case "killnote":
                    noted.Add((S(j, "to"), S(j, "kind")));
                    break;
                case "attack":
                    attacks.Add((F(j, "t"), S(j, "p")));
                    break;
                case "trig":
                    if (Has(j, "tamed") && j.GetProperty("tamed").GetBoolean() && S(j, "fol") != null)
                        summons.Add((F(j, "t"), S(j, "fol"), Pos(j)));
                    break;
            }
        }
        // their own attack within HitWindow before a deletion of that kind, within AttackerRange of it
        bool Struck(string player, string kind) => destroys.Any(d => d.Kind == kind && d.Players.Any(p => p.N == player
            && Vec.Distance(p.Pos, d.Pos) <= CombatCore.AttackerRange
            && attacks.Any(a => a.Player == player && a.T <= d.T && d.T - a.T <= CombatCore.HitWindow)));
        bool Noted(string player, string kind) => noted.Any(n => n.Player == player && n.Token.EndsWith("_" + kind.Split('*')[0].ToLowerInvariant()));
        bool ViaSummon(string player, string kind) => summons.Any(s => s.Player == player
            && seen.Any(c => c.Kind == kind && System.Math.Abs(c.T - s.T) <= 10 && Vec.Distance(c.Pos, s.Pos) <= 40));
        var violations = new List<string>();
        foreach (var ((e, p, i), n) in now)
        {
            if (e != "dmg" && e != "kill")
                continue;
            if (!listed.Contains((p, i)) && !ViaSummon(p, i) && !hitters.Contains((p, i)) && !Noted(p, i) && !Struck(p, i))
                violations.Add($"I1: {p} credited {e} {n:0.#} on {i} without evidence (attacker list, routed hit, kill note, own attack in reach, summon)");
        }
        foreach (var ((e, p, i), n) in now)
            if (e == "kill" && n > deaths.GetValueOrDefault(i) + 1e-6)
                violations.Add($"I3: {p} has {n} kills of {i}, the trace has {deaths.GetValueOrDefault(i)} deaths");
        foreach (var kind in now.Keys.Where(k => k.Item1 == "ukill").Select(k => k.Item3).Distinct())
        {
            var unaccounted = now[("ukill", "", kind)];
            var credited = now.Where(x => x.Key.Item1 == "kill" && x.Key.Item3 == kind).Select(x => x.Value).DefaultIfEmpty(0).Max();
            if (unaccounted + credited > deaths.GetValueOrDefault(kind) + 1e-6 && !kind.Contains('/'))
                violations.Add($"I3: {kind}: {unaccounted} unaccounted + {credited} credited kills, the trace has {deaths.GetValueOrDefault(kind)} deaths");
        }
        foreach (var kv in Remaining)
            lost[kv.Key] = lost.GetValueOrDefault(kv.Key) + kv.Value;
        var coverage = lost.OrderByDescending(kv => kv.Value).Select(kv =>
        {
            var credited = now.Where(x => x.Key.Item1 == "dmg" && x.Key.Item3 == kv.Key).Sum(x => x.Value);
            return $"{kv.Key}: lost {kv.Value:0} (synced drops + health left at counted deaths), credited to players {credited:0} ({(kv.Value > 0 ? credited / kv.Value : 1):P0})";
        }).ToList();
        return (violations, coverage);
    }

    // of the last Run: per creature name, the health its counted deaths still had (never synced as drops)
    internal static readonly Dictionary<string, double> Remaining = new Dictionary<string, double>();

    private static bool Has(JsonElement j, string k) => j.TryGetProperty(k, out var v) && v.ValueKind != JsonValueKind.Null;

    // "Skeleton_Friendly*1" / "player:Ragnar" → the prefab
    private static string Prefab(string who) => who.Split('*')[0];

    private static CombatMeta Meta(JsonElement j, HashSet<string> weaponsSeen)
    {
        var meta = new CombatMeta();
        if (j.TryGetProperty("names", out var names))
            foreach (var n in names.EnumerateObject())
                meta.Names[n.Name] = n.Value.GetString();
        if (j.TryGetProperty("weapons", out var weapons))
            foreach (var w in weapons.EnumerateObject())
                meta.Weapons[w.Name] = (w.Value.GetProperty("ranged").GetBoolean(), (float)w.Value.GetProperty("reach").GetDouble(),
                    w.Value.GetProperty("harmful").GetBoolean());
        if (j.TryGetProperty("ragdolls", out var ragdolls))
            foreach (var r in ragdolls.EnumerateObject())
                meta.Ragdolls[r.Name] = r.Value.EnumerateArray().Select(c => c.GetString()).ToList();
        if (j.TryGetProperty("drops", out var drops) && drops.ValueKind == JsonValueKind.Object)
            foreach (var d in drops.EnumerateObject())
                meta.Drops[d.Name] = d.Value.EnumerateObject().ToDictionary(i => i.Name, i => (float)i.Value.GetDouble());
        if (j.TryGetProperty("noragdoll", out var none))
            foreach (var n in none.EnumerateArray())
                meta.NoRagdoll.Add(n.GetString());
        if (j.TryGetProperty("timed", out var timed))
            foreach (var t in timed.EnumerateArray())
                meta.Timed.Add(t.GetString());
        if (j.TryGetProperty("cost", out var cost) && cost.ValueKind == JsonValueKind.Object)
            foreach (var c in cost.EnumerateObject())
                meta.Costs[c.Name] = ((float)c.Value.GetProperty("f").GetDouble(), (float)c.Value.GetProperty("p").GetDouble());
        else if (cost.ValueKind == JsonValueKind.Array) // first trace v2 builds: [{"w","a","f","p"}]
            foreach (var c in cost.EnumerateArray())
                meta.Costs[S(c, "w") + "/" + S(c, "a")] = (F(c, "f"), F(c, "p"));
        if (j.TryGetProperty("reach", out var reach))
            foreach (var r in reach.EnumerateObject())
                meta.Reach[r.Name] = (float)r.Value.GetDouble();
        if (!j.TryGetProperty("weapons", out _))
            // older traces: bows, crossbows and damaging staffs shoot; blood magic (a health cost) and shields do no damage
            foreach (var w in weaponsSeen)
            {
                var costs = meta.Costs.Keys.Any(k => k.StartsWith(w + "/"));
                var ranged = w.StartsWith("Bow") || w.StartsWith("Crossbow") || w.StartsWith("Staff");
                meta.Weapons[w] = (ranged, MeleeGuess, !costs && w != "StaffShield");
            }
        return meta;
    }

    private const float MeleeGuess = 3f;

    internal static (Dictionary<(string, string, string), double> Now, Dictionary<(string, string, string), double> Then) Run(string file) =>
        Run(File.ReadLines(file));

    // The same sums, to a precision floats can promise.
    internal static bool Same(Dictionary<(string, string, string), double> a, Dictionary<(string, string, string), double> b) =>
        a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var v) && System.Math.Abs(v - kv.Value) < 1e-3);

    private static float F(JsonElement j, string k) => (float)j.GetProperty(k).GetDouble();
    private static float? N(JsonElement j, string k) => j.GetProperty(k).ValueKind == JsonValueKind.Null ? null : F(j, k);
    private static string S(JsonElement j, string k) => j.GetProperty(k).ValueKind == JsonValueKind.Null ? null : j.GetProperty(k).GetString();
    private static Vec Pos(JsonElement j) => new Vec(F(j, "x"), F(j, "y"), F(j, "z"));

    private static List<PlayerState> Players(JsonElement j, string k) =>
        j.GetProperty(k).EnumerateArray().Select(p => new PlayerState(S(p, "n"), p.GetProperty("b").GetBoolean(),
            p.GetProperty("d").GetBoolean(), Pos(p), S(p, "h"))).ToList();
}
