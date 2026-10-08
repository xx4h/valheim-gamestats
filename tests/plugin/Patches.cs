// Every Harmony hook of the plugin against the game's own assemblies, without running the game: the method it patches
// exists (with that overload), and every argument the patch asks for is there — a parameter of that name, or a field
// for ___name. That is what a game update breaks; Harmony would only find out on the server, at the restart.
// Reads the built plugin (plugin/bin/Release/net48) and the game's assemblies (plugin/lib, from plugin/fetch-refs.sh).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

static class Patches
{
    const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // problems found, empty when every hook fits
    public static List<string> Check(string plugin, string lib)
    {
        // the game's mscorlib / netstandard references resolve to this runtime's forwarders
        var runtime = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var paths = Directory.GetFiles(lib, "*.dll").Concat(Directory.GetFiles(runtime, "*.dll")).Append(plugin);
        using var mlc = new MetadataLoadContext(new PathAssemblyResolver(paths));
        var asm = mlc.LoadFromAssemblyPath(plugin);
        var problems = new List<string>();
        var found = 0;
        foreach (var type in asm.GetTypes())
        {
            var attr = type.GetCustomAttributesData().FirstOrDefault(a => a.AttributeType.Name == "HarmonyPatch");
            if (attr == null)
                continue;
            found++;
            var args = attr.ConstructorArguments;
            var target = (Type)args[0].Value;
            var name = (string)args[1].Value;
            var types = args.Count > 2 ? ((IEnumerable<CustomAttributeTypedArgument>)args[2].Value).Select(a => (Type)a.Value).ToArray() : null;
            var candidates = Members(target).OfType<MethodInfo>().Where(m => m.Name == name).ToList();
            if (types != null)
                candidates = candidates.Where(m => m.GetParameters().Select(p => p.ParameterType.FullName).SequenceEqual(types.Select(t => t.FullName))).ToList();
            var where = $"{type.Name} → {target.Name}.{name}";
            if (candidates.Count != 1)
            {
                problems.Add($"{where}: {candidates.Count} matching methods in the game");
                continue;
            }
            var method = candidates[0];
            foreach (var patch in type.GetMethods(All).Where(m => m.Name is "Prefix" or "Postfix" or "Finalizer"))
                foreach (var p in patch.GetParameters())
                {
                    if (p.Name is "__instance" or "__state" or "__result" or "__originalMethod" or "__exception")
                        continue;
                    if (p.Name.StartsWith("___"))
                    {
                        var field = Members(target).OfType<FieldInfo>().FirstOrDefault(f => f.Name == p.Name.Substring(3));
                        if (field == null)
                            problems.Add($"{where}: {patch.Name} wants field {p.Name.Substring(3)}, the game has none");
                        else if (Strip(p.ParameterType).FullName != field.FieldType.FullName)
                            problems.Add($"{where}: {patch.Name} wants {p.Name} as {Strip(p.ParameterType).Name}, the game's is {field.FieldType.Name}");
                        continue;
                    }
                    var arg = method.GetParameters().FirstOrDefault(a => a.Name == p.Name);
                    if (arg == null)
                        problems.Add($"{where}: {patch.Name} wants argument {p.Name}, the method has ({string.Join(", ", method.GetParameters().Select(a => a.Name))})");
                    else if (Strip(p.ParameterType).FullName != Strip(arg.ParameterType).FullName)
                        problems.Add($"{where}: {patch.Name} wants {p.Name} as {Strip(p.ParameterType).Name}, the method's is {arg.ParameterType.Name}");
                }
        }
        if (found < 10)
            problems.Add($"only {found} patch classes found in {plugin} — is it the right build?");
        Console.WriteLine($"       {found} hooks checked against the game");
        return problems;
    }

    static Type Strip(Type t) => t.IsByRef ? t.GetElementType() : t;

    // a type's members and its base types' (fields like m_randomEvent may sit on a base)
    static IEnumerable<MemberInfo> Members(Type t)
    {
        for (; t != null; t = t.BaseType)
            foreach (var m in t.GetMembers(All))
                yield return m;
    }
}
