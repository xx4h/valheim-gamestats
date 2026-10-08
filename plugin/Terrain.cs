// Samples the whole world once with the game's own WorldGenerator — biome and height on a 2048 × 2048
// grid, ~10 m apart — for the terrain under the gamestats map (collector/valheim_gamestats/mapimg.py draws it). The file is
// named by the world seed and only written when missing, so a restart costs nothing; it runs on a
// background thread (the game builds its heightmaps off the main thread too) and takes about a minute.
//
// BepInEx/gamestats/terrain-<seed>.bin.gz, gzip of (little endian):
//   "GSTR", int version (1), int size, float extent (m, half the side), int seed,
//   short height (dm) × size², byte biome (log2 of the Heightmap.Biome flag + 1) × size².
//   Row 0 is the north edge, column 0 the west edge.
// BepInEx/gamestats/terrain.json names the current file, for the collector.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Threading;
using BepInEx;
using UnityEngine;

namespace ValheimGamestats
{
    internal static class Terrain
    {
        private const int Size = 2048;
        private const float Extent = WorldGenerator.waterEdge;
        private const int Format = 1;
        private static bool started;

        private static string Dir => Path.Combine(Paths.BepInExRootPath, "gamestats");

        internal static void Tick()
        {
            if (started || WorldGenerator.instance == null || ZNet.instance == null || !ZNet.instance.IsServer())
                return;
            started = true;
            var gen = WorldGenerator.instance;
            var seed = gen.GetSeed();
            var name = $"terrain-{seed}.bin.gz";
            if (File.Exists(Path.Combine(Dir, name)))
                return;
            new Thread(() => Render(gen, seed, name)) { IsBackground = true, Priority = System.Threading.ThreadPriority.BelowNormal, Name = "gamestats-terrain" }.Start();
        }

        private static void Render(WorldGenerator gen, int seed, string name)
        {
            try
            {
                var clock = Stopwatch.StartNew();
                var heights = new short[Size * Size];
                var biomes = new byte[Size * Size];
                var step = 2 * Extent / Size;
                for (var r = 0; r < Size; r++)
                {
                    var z = Extent - (r + 0.5f) * step;
                    for (var c = 0; c < Size; c++)
                    {
                        var x = -Extent + (c + 0.5f) * step;
                        var biome = gen.GetBiome(x, z);
                        var h = gen.GetBiomeHeight(biome, x, z, out _);
                        heights[r * Size + c] = (short)Mathf.Clamp(Mathf.RoundToInt(h * 10), short.MinValue, short.MaxValue);
                        biomes[r * Size + c] = Index(biome);
                    }
                }
                Directory.CreateDirectory(Dir);
                var file = Path.Combine(Dir, name);
                var tmp = file + ".tmp";
                using (var fs = File.Create(tmp))
                using (var gz = new GZipStream(fs, System.IO.Compression.CompressionLevel.Optimal))
                using (var w = new BinaryWriter(gz))
                {
                    w.Write(new[] { (byte)'G', (byte)'S', (byte)'T', (byte)'R' });
                    w.Write(Format);
                    w.Write(Size);
                    w.Write(Extent);
                    w.Write(seed);
                    var raw = new byte[heights.Length * 2];
                    Buffer.BlockCopy(heights, 0, raw, 0, raw.Length);
                    w.Write(raw);
                    w.Write(biomes);
                }
                if (File.Exists(file))
                    File.Delete(file);
                File.Move(tmp, file);
                var t = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds;
                File.WriteAllText(Path.Combine(Dir, "terrain.json"), $"{{\"file\":\"{name}\",\"seed\":{seed},\"size\":{Size},\"extent\":{Extent},\"t\":{t}}}");
                ZLog.Log($"[Gamestats terrain] {Size}x{Size} samples in {clock.Elapsed.TotalSeconds:0}s -> {name}");
            }
            catch (Exception e)
            {
                ZLog.LogError($"[Gamestats terrain] failed: {e}");
            }
        }

        private static byte Index(Heightmap.Biome biome)
        {
            var v = (int)biome;
            byte i = 0;
            while (v > 0)
            {
                v >>= 1;
                i++;
            }
            return i;
        }
    }
}
