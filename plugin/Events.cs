// Where the plugin's events go: its own store on the server's disk (EventStore.cs, BepInEx/gamestats/events/), not the
// server log (since 1.18.0; LogToo brings the old "[Gamestats] {…}" lines back for debugging). The RCON command
// `gs_events <after>` hands the collector what came after the last number it has.
//
// Warnings stay in the log either way ("[Gamestats] <area>: …"): they are what the log is for, and the collector's
// health checks read them — most of all when the plugin is too broken to write its own store.
using System.IO;
using ValheimRcon.Commands;

namespace ValheimGamestats
{
    internal static class Events
    {
        internal static bool LogToo;
        private static EventStore _store;

        internal static void Init(string root)
        {
            try
            {
                _store = new EventStore(Path.Combine(root, "gamestats", "events"), (msg) => ZLog.LogWarning("[Gamestats] " + msg));
            }
            catch (System.Exception e)
            {
                ZLog.LogWarning("[Gamestats] events: init: " + e.Message);
            }
        }

        // body: one JSON object, {"e":…}. log: true = to the server log too (the plugin's start line), false = never
        // (events that never were in the log), null = while LogToo.
        internal static void Emit(string body, bool? log = null)
        {
            if (log ?? LogToo)
                ZLog.Log("[Gamestats] " + body);
            _store?.Append(body);
        }

        // A problem: to the log for whoever reads it, and to the store as {"e":"warn","i":<area>,"msg":…} for the
        // collector — at most once a minute per area, a broken hook runs on every update.
        internal static void Warn(string area, string msg)
        {
            ZLog.LogWarning("[Gamestats] " + area + ": " + msg);
            var now = UnityEngine.Time.realtimeSinceStartup;
            if (Warned.TryGetValue(area, out var last) && now - last < 60f)
                return;
            Warned[area] = now;
            var sb = new System.Text.StringBuilder("{\"e\":\"warn\",\"p\":\"\",\"i\":");
            Gather.Json(sb, area).Append(",\"n\":1,\"msg\":");
            _store?.Append(Gather.Json(sb, msg).Append('}').ToString());
        }

        private static readonly System.Collections.Generic.Dictionary<string, float> Warned = new System.Collections.Generic.Dictionary<string, float>();

        internal static void Close() => _store?.Close();

        internal static string After(long after) =>
            _store?.After(after) ?? "{\"id\":\"\",\"head\":0,\"oldest\":1,\"error\":\"no event store, see the server log\"}";
    }

    // RCON: gs_events <after> — the events after that number (see EventStore.After)
    internal class EventsCommand : RconCommand
    {
        public override string Command => "gs_events";
        public override string Description => "Gamestats events after a sequence number, one JSON object per line";

        protected override string OnHandle(CommandArgs args) => Events.After(args.TryGetLong(0, 0));
    }
}
