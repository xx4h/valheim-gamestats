// Who discovered a zone, for the gamestats collector. The server generates the zones around every connected player
// (ZoneSystem.CreateGhostZones per peer, within the simulation distance), so when one becomes generated
// (SetZoneGenerated) the players involved are those whose position is within that distance of it — usually the one
// exploring, or a group together; not everyone who happens to be online elsewhere. The log only says "Placed location …
// in zone …", and only for zones with a location; this covers every zone:
//   [Gamestats] {"e":"zone","p":"","i":"12,-90","n":1,"by":["Ragnar"],"l":["Crypt3"]}
// l (since 1.17.0) = the location placed in the zone, if any.
// by = [] when the server generated it on its own (the spawn area of a new world).
using System.Collections.Generic;
using System.Text;
using HarmonyLib;
using UnityEngine;

namespace ValheimGamestats
{
    [HarmonyPatch(typeof(ZoneSystem), "SetZoneGenerated")]
    internal static class ZoneGeneratedPatch
    {
        private static void Postfix(Vector2s zoneID, SimulationDistance ___m_simulationDistance)  // Harmony hands over the private field
        {
            if (ZNet.instance == null || !ZNet.instance.IsServer() || ZoneSystem.instance == null)
                return;
            try
            {
                var reach = ___m_simulationDistance.TotalSimulationDistance;
                var by = new List<string>();
                foreach (var peer in ZNet.instance.GetPeers())
                {
                    var at = ZoneSystem.GetZone(peer.GetRefPos());
                    if (Mathf.Abs(at.x - zoneID.x) <= reach && Mathf.Abs(at.y - zoneID.y) <= reach && !string.IsNullOrEmpty(peer.m_playerName))
                        by.Add(peer.m_playerName);
                }
                var sb = new StringBuilder("{\"e\":\"zone\",\"p\":\"\",\"i\":\"").Append(zoneID.x).Append(',').Append(zoneID.y)
                    .Append("\",\"n\":1,\"by\":[");
                for (var i = 0; i < by.Count; i++)
                    Gather.Json(i > 0 ? sb.Append(',') : sb, by[i]);
                sb.Append(']');
                // the location placed in it a moment ago (PlaceLocations runs first): the game's "Placed location … in
                // zone …" (m_prefabName is its prefab's name)
                if (ZoneSystem.instance.m_locationInstances.TryGetValue(zoneID, out var li) && li.m_placed && !string.IsNullOrEmpty(li.m_location?.m_prefabName))
                    Gather.Json(sb.Append(",\"l\":["), li.m_location.m_prefabName).Append(']');
                Events.Emit(sb.Append('}').ToString());
            }
            catch (System.Exception e)
            {
                Events.Warn("zones", e.Message);
            }
        }
    }
}
