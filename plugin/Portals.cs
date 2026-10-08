// Adds the RCON command `portals`: every portal with its tag, position and the portal the game has actually linked it
// to, as one line of JSON for the gamestats collector — [["tag",x,z,partner],…], partner = index in the list or -1.
// The world save only says which portals share a tag; the game pairs them itself (Game.ConnectPortals, every few
// seconds: two with the same tag, a third stays unlinked) and keeps the pair as a ZDO connection. This is that pairing,
// as it is now.
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using ValheimRcon.Commands;

namespace ValheimGamestats
{
    internal class Portals : RconCommand
    {
        public override string Command => "portals";
        public override string Description => "Every portal with its tag, position and linked partner, as JSON";

        private const int MaxReply = 3800;  // ValheimRcon truncates replies at ~4 KB

        protected override string OnHandle(CommandArgs args)
        {
            var list = ZDOMan.instance.GetPortalList();
            var index = new Dictionary<ZDOID, int>();
            for (var i = 0; i < list.Count; i++)
                index[list[i].m_uid] = i;
            var sb = new StringBuilder("[");
            for (var i = 0; i < list.Count; i++)
            {
                var zdo = list[i];
                var to = zdo.GetConnectionZDOID(ZDOExtraData.ConnectionType.Portal);
                var partner = !to.IsNone() && index.TryGetValue(to, out var j) ? j : -1;
                var pos = zdo.GetPosition();
                var item = new StringBuilder(i > 0 ? "," : "").Append('[');
                Gather.Json(item, zdo.GetString(ZDOVars.s_tag)).Append(',').Append(Mathf.RoundToInt(pos.x)).Append(',')
                    .Append(Mathf.RoundToInt(pos.z)).Append(',').Append(partner).Append(']');
                if (sb.Length + item.Length + 1 > MaxReply)
                    break;  // a partner index past the cut just points nowhere
                sb.Append(item);
            }
            return sb.Append(']').ToString();
        }
    }
}
