// The plugin's own record of what happened, on the game server's disk instead of in its log: one JSON object per
// line in <dir>/<UTC day>.jsonl, each with a sequence number and the time —
//   {"s":1234,"t":1791370829290,"e":"kill","p":"Ragnar","i":"Troll","n":1}
// The files live on the server's own volume, so nothing is lost when the collector hasn't read them before a restart;
// it asks for what came after the last number it has (After), as often as it likes. A gap in the numbers is exactly
// what is missing. A line torn by a crash is skipped; day files beyond keepDays go.
//
// Plain .NET, nothing from the game: tests/EventStoreTests runs it outside Valheim. Events.cs connects it to the game.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace ValheimGamestats
{
    internal class EventStore
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        private readonly object _lock = new object();
        private readonly Queue<KeyValuePair<long, string>> _recent = new Queue<KeyValuePair<long, string>>();
        private readonly string _dir;
        private readonly int _keepDays, _recentMax, _maxReply;
        private readonly Action<string> _warn;
        private readonly Func<DateTimeOffset> _now;
        private string _day;
        private long _seq, _oldest;
        private StreamWriter _out;
        private DateTimeOffset _warned = DateTimeOffset.MinValue;

        internal string Id { get; }

        internal long Head
        {
            get { lock (_lock) return _seq; }
        }

        // warn: where problems go (the server log); now: the clock (tests set it)
        internal EventStore(string dir, Action<string> warn, Func<DateTimeOffset> now = null, int keepDays = 90, int recentMax = 20000,
            int maxReply = 3800)
        {
            _dir = dir;
            _warn = warn;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _keepDays = keepDays;
            _recentMax = recentMax;  // events kept in memory to answer from (a few days of play)
            _maxReply = maxReply;    // ValheimRcon cuts replies at ~4 KB
            Directory.CreateDirectory(_dir);
            // the store's identity: a wiped or new store starts its numbers again, the collector must notice
            var idFile = Path.Combine(_dir, "store-id");
            if (!File.Exists(idFile))
                File.WriteAllText(idFile, Guid.NewGuid().ToString("N"));
            Id = File.ReadAllText(idFile).Trim();
            var days = Prune();
            _seq = days.Count > 0 ? LastSeq(days[days.Count - 1]) : 0;
            _oldest = days.Count > 0 ? FirstSeq(days[0]) : _seq + 1;
        }

        // body: one JSON object, {"e":…}. Returns its number, 0 if it couldn't be written.
        internal long Append(string body)
        {
            lock (_lock)
            {
                var now = _now();
                var line = new StringBuilder("{\"s\":").Append(_seq + 1).Append(",\"t\":").Append(now.ToUnixTimeMilliseconds()).Append(',')
                    .Append(body, 1, body.Length - 1).ToString();
                if (line.Length + 1 + ReplyHead > _maxReply)
                {
                    // a reply never holds it (After stops before it), so the collector would ask for it forever: refused,
                    // its number stays free — the stream goes on
                    Warn("too big", $"{body.Substring(0, Math.Min(40, body.Length))}… ({line.Length} bytes) not stored");
                    return 0;
                }
                try
                {
                    var day = now.UtcDateTime.ToString("yyyy-MM-dd");
                    if (_out == null || day != _day)
                    {
                        _out?.Dispose();
                        var path = Path.Combine(_dir, day + ".jsonl");
                        var torn = TornEnd(path);
                        _out = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), Utf8)
                            { AutoFlush = true };
                        if (torn)
                            _out.Write("\n");  // a crash cut the last line: it stays alone (and is skipped), ours starts fresh
                        if (_day != null && day != _day)
                        {
                            var days = Prune();
                            _oldest = days.Count > 0 ? FirstSeq(days[0]) : _seq + 1;
                        }
                        _day = day;
                    }
                    _out.Write(line + "\n");
                }
                catch (Exception e)
                {
                    _out?.Dispose();
                    _out = null;
                    Warn("write", e);
                    return 0;  // not written: the number stays free, the next event takes it
                }
                _seq++;
                _recent.Enqueue(new KeyValuePair<long, string>(_seq, line));
                while (_recent.Count > _recentMax)
                    _recent.Dequeue();
                return _seq;
            }
        }

        internal void Close()
        {
            lock (_lock)
            {
                _out?.Dispose();
                _out = null;
            }
        }

        // First line: {"id":store,"head":last number,"oldest":first number still kept}; then the events after `after`, oldest
        // first, as many as fit in one reply. The collector asks again from the last number it got until none come.
        internal string After(long after)
        {
            lock (_lock)
            {
                var sb = new StringBuilder("{\"id\":\"").Append(Id).Append("\",\"head\":").Append(_seq).Append(",\"oldest\":").Append(_oldest).Append('}');
                if (after >= _seq)
                    return sb.ToString();
                try
                {
                    var fromMemory = _recent.Count > 0 && _recent.Peek().Key <= after + 1;
                    foreach (var line in fromMemory ? FromMemory(after) : FromDisk(after))
                    {
                        if (sb.Length + line.Length + 1 > _maxReply)
                            break;
                        sb.Append('\n').Append(line);
                    }
                }
                catch (Exception e)
                {
                    Warn("read", e);
                }
                return sb.ToString();
            }
        }

        private IEnumerable<string> FromMemory(long after)
        {
            foreach (var kv in _recent)
                if (kv.Key > after)
                    yield return kv.Value;
        }

        private IEnumerable<string> FromDisk(long after)
        {
            var days = Days();
            for (var i = 0; i < days.Count; i++)
            {
                if (i + 1 < days.Count && FirstSeq(days[i + 1]) <= after + 1)
                    continue;  // all of this day is older
                foreach (var line in ReadLines(days[i]))
                    if (SeqOf(line) > after)
                        yield return line;
            }
        }

        private List<string> Prune()
        {
            var days = Days();
            for (var i = 0; i < days.Count - _keepDays; i++)
                File.Delete(days[i]);
            return Days();
        }

        private List<string> Days()
        {
            var days = new List<string>(Directory.GetFiles(_dir, "????-??-??.jsonl"));
            days.Sort(StringComparer.Ordinal);
            return days;
        }

        // shared read: the writer has today's file open
        private static IEnumerable<string> ReadLines(string path)
        {
            using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var r = new StreamReader(f, Utf8))
            {
                string line;
                while ((line = r.ReadLine()) != null)
                    if (line.EndsWith("}") && SeqOf(line) > 0)
                        yield return line;
            }
        }

        private static bool TornEnd(string path)
        {
            if (!File.Exists(path))
                return false;
            using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (f.Length == 0)
                    return false;
                f.Seek(-1, SeekOrigin.End);
                return f.ReadByte() != '\n';
            }
        }

        private static long FirstSeq(string path)
        {
            foreach (var line in ReadLines(path))
                return SeqOf(line);
            return long.MaxValue;
        }

        private static long LastSeq(string path)
        {
            long last = 0;
            foreach (var line in ReadLines(path))
                last = SeqOf(line);
            return last;
        }

        // {"s":1234,… — the number is always first
        internal static long SeqOf(string line)
        {
            if (!line.StartsWith("{\"s\":", StringComparison.Ordinal))
                return 0;
            long n = 0;
            for (var i = 5; i < line.Length && line[i] >= '0' && line[i] <= '9'; i++)
                n = n * 10 + (line[i] - '0');
            return n;
        }

        private void Warn(string what, Exception e) => Warn(what, e.Message);

        private void Warn(string what, string msg)
        {
            var now = _now();
            if (now - _warned < TimeSpan.FromMinutes(1))
                return;  // a full disk shouldn't flood the log either: once a minute
            _warned = now;
            _warn("events: " + what + ": " + msg);
        }

        // the reply's first line ({"id":"<32 hex>","head":…,"oldest":…}) at its longest, and its line break
        private const int ReplyHead = 96;
    }
}
