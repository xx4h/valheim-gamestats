// The event store — what the collector relies on: every event once, in order, with no gaps — across restarts, day files, torn lines,
// replies cut at ~4 KB and cursors older than what's kept in memory.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ValheimGamestats;

static class Program
{
    static int failed;
    static DateTimeOffset now = new DateTimeOffset(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);
    static readonly List<string> warnings = new List<string>();

    static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
        if (!ok) failed++;
    }

    static string Dir() => Directory.CreateTempSubdirectory("events").FullName;

    static EventStore Open(string dir, int recentMax = 20000, int maxReply = 3800, int keepDays = 90) =>
        new EventStore(dir, warnings.Add, () => now, keepDays, recentMax, maxReply);

    static string Ev(int i) => "{\"e\":\"kill\",\"p\":\"Ragnar\",\"i\":\"Troll\",\"n\":" + i + "}";

    // the collector's loop: ask after the last number until nothing new comes
    static (string head, List<string> lines) ReadAll(EventStore store, long after)
    {
        var lines = new List<string>();
        string head = null;
        for (var calls = 0; calls < 10000; calls++)
        {
            var reply = store.After(after).Split('\n');
            head ??= reply[0];
            if (reply.Length == 1)
                break;
            lines.AddRange(reply.Skip(1));
            after = EventStore.SeqOf(reply[reply.Length - 1]);
        }
        return (head, lines);
    }

    static bool Json(string line)
    {
        try { System.Text.Json.JsonDocument.Parse(line).Dispose(); return true; }
        catch (System.Text.Json.JsonException) { return false; }
    }

    static bool Consecutive(List<string> lines, long first) =>
        lines.Select(EventStore.SeqOf).SequenceEqual(Enumerable.Range(0, lines.Count).Select(i => first + i));

    static int Main(string[] args)
    {
        {
            var dir = Dir();
            var s = Open(dir);
            for (var i = 1; i <= 5; i++)
                s.Append(Ev(i));
            var (head, lines) = ReadAll(s, 0);
            Check(lines.Count == 5 && Consecutive(lines, 1), "numbers 1..5 in order");
            Check(lines[0].StartsWith("{\"s\":1,\"t\":") && lines[0].EndsWith(",\"e\":\"kill\",\"p\":\"Ragnar\",\"i\":\"Troll\",\"n\":1}"), "line = number, time, event");
            Check(head.Contains("\"head\":5") && head.Contains("\"oldest\":1") && head.Contains(s.Id), "header: store id, head, oldest");
            Check(s.After(5) == head, "nothing after the head");
            s.Close();

            // a restart: numbering goes on, the store keeps its id
            var id = s.Id;
            s = Open(dir);
            s.Append(Ev(6));
            Check(s.Head == 6 && s.Id == id, "restart: numbering continues, same store id");
            Check(ReadAll(s, 5).lines.Count == 1, "restart: the event after the cursor");
            Check(Consecutive(ReadAll(s, 0).lines, 1), "restart: older events read from disk");
            s.Close();

            // a crash mid-line: the torn line is skipped, its number reused
            File.AppendAllText(Path.Combine(dir, "2026-10-07.jsonl"), "{\"s\":7,\"t\":1,\"e\":\"ki");
            s = Open(dir);
            s.Append(Ev(7));
            var all = ReadAll(s, 0).lines;
            Check(all.Count == 7 && Consecutive(all, 1), "torn line skipped, no gap, no duplicate");
            Check(all.All(Json), "every line is whole JSON");
            s.Close();
            Check(Open(Dir()).Id != id, "a new store has a new id");
        }
        {
            // replies cut at maxReply, events older than memory, across days
            var dir = Dir();
            var s = Open(dir, recentMax: 50, maxReply: 400);
            for (var i = 1; i <= 300; i++)
            {
                if (i % 100 == 0) now = now.AddDays(1);
                s.Append(Ev(i));
            }
            Check(Directory.GetFiles(dir, "*.jsonl").Length == 4, "a file per UTC day");
            Check(s.After(0).Length <= 400, "a reply fits the limit");
            var (_, lines) = ReadAll(s, 0);
            Check(lines.Count == 300 && Consecutive(lines, 1), "paged from disk and memory: all 300, in order, once");
            var (_, tail) = ReadAll(s, 120);
            Check(tail.Count == 180 && Consecutive(tail, 121), "from a cursor in an older day file");
            s.Close();

            // only keepDays files stay; a cursor older than that sees the gap
            s = Open(dir, keepDays: 2);
            var (head, kept) = ReadAll(s, 0);
            Check(Directory.GetFiles(dir, "*.jsonl").Length == 2 && head.Contains("\"oldest\":200"), "older days pruned, header says what's kept");
            Check(EventStore.SeqOf(kept[0]) == 200 && Consecutive(kept, 200), "a cursor before the oldest gets the oldest: the gap shows");
            s.Close();
        }
        {
            // can't write: the event is lost, its number isn't; one warning a minute, not one per event
            var dir = Dir();
            var s = Open(dir);
            s.Append(Ev(1));
            s.Close();
            Directory.Delete(dir, true);
            warnings.Clear();
            now = now.AddDays(1);
            var n = s.Append(Ev(2)) + s.Append(Ev(3));
            Check(n == 0 && warnings.Count == 1 && warnings[0].StartsWith("events: write:"), "write failure: nothing numbered, one warning");
            Directory.CreateDirectory(dir);
            Check(s.Append(Ev(4)) == 2, "writable again: the next number follows the last written one");
        }
        {
            // the hooks against the game: needs the built plugin and plugin/lib (skipped without, CI always has both)
            var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
            var plugin = Path.Combine(root, "plugin/bin/Release/net48/ValheimGamestats.dll");
            var lib = Path.Combine(root, "plugin/lib");
            if (!File.Exists(plugin) || !Directory.Exists(lib))
                Check(Environment.GetEnvironmentVariable("CI") == null, "hooks: skipped, build the plugin first (CI: required)");
            else
                foreach (var problem in Patches.Check(plugin, lib).DefaultIfEmpty(null))
                    Check(problem == null, problem ?? "every hook fits the game's methods and fields");
        }
        CombatTests.Run(Check);
        if (args.Length == 2 && args[0] == "replay")
        {
            // dotnet run -- replay <trace.jsonl>: a real session through today's CombatCore, against what the plugin made of it
            var (now, then) = Replay.Run(args[1]);
            foreach (var key in now.Keys.Union(then.Keys).OrderBy(k => k))
            {
                now.TryGetValue(key, out var a);
                then.TryGetValue(key, out var b);
                if (Math.Abs(a - b) >= 1e-3)
                    Console.WriteLine($"  {key.Item1} {key.Item2} {key.Item3}: then {b:0.##}, now {a:0.##}");
            }
            Check(Replay.Same(now, then), $"replay {Path.GetFileName(args[1])}: {then.Count} sums as recorded");
            var (violations, coverage) = Replay.Invariants(File.ReadLines(args[1]), now);
            foreach (var v in violations)
                Console.WriteLine("  " + v);
            Check(violations.Count == 0, $"replay {Path.GetFileName(args[1])}: invariants I1 (credit needs evidence), I3 (each death once)");
            foreach (var c in coverage)
                Console.WriteLine("  coverage " + c);
        }
        Console.WriteLine(failed == 0 ? "all passed" : $"{failed} failed");
        return failed == 0 ? 0 : 1;
    }
}
