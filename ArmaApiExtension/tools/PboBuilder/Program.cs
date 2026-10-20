// PBO packer for Arma 3 (Bohemia Interactive PBO file format).
//
// Reverse engineered from an AddonBuilder 1.x produced PBO:
//
//   byte     0x00
//   char[4]  "sreV"
//   byte[16] frame header (method/size/time/modified, zeroed by AddonBuilder)
//   entry    0: name field of 16 bytes holding the PBOX prefix, then its data block.
//              AddonBuilder writes the name as "prefix\0Functions\0\0" (the prefix is
//              split over the 16 byte name field and the following NUL terminated
//              string), followed by a 16 byte entry header (method/original size/
//              time/size) and the prefix payload.
//   entry*   file names, 16 byte header, payload
//   entry    empty name + 16 zero bytes = header terminator
//   ...      payloads in file order, no checksums, no file hashes, no DLC index
//
// This tool produces exactly that layout, so the result is byte-for-byte comparable
// in structure to an AddonBuilder PBO (keeping [onDisk/...] load order predictable).

using System.Security.Cryptography;
using System.Text;

namespace PboBuilder;

internal enum PackingMethod : uint
{
    Uncompressed = 0x00000000,
    Compressed = 0x43707273
}

internal sealed record PboEntry(string RelativePath, string SourcePath, PackingMethod Method, uint OriginalSize, uint TimeStamp);

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "-h" or "--help")
            {
                PrintUsage();
                return args.Length == 0 ? 1 : 0;
            }

            var options = Options.Parse(args);

            string source = Path.GetFullPath(options.Source);
            string outputFile = Path.GetFullPath(options.Output);

            if (!Directory.Exists(source))
            {
                Console.Error.WriteLine($"Source directory not found: {source}");
                return 2;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputFile)!);

            string prefix = ResolvePrefix(source, options.PrefixFile);
            var entries = CollectEntries(source, options.Prefixes, options.Excludes);

            byte[] pbo = BuildPbo(entries, prefix);

            File.WriteAllBytes(outputFile, pbo);

            byte[] hash = SHA256.HashData(pbo);

            if (!string.IsNullOrEmpty(options.HashFile))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(options.HashFile))!);
                File.WriteAllText(options.HashFile, Convert.ToHexString(hash));
            }

            Console.WriteLine($"Packed {entries.Count} files into {outputFile}");
            Console.WriteLine($"Prefix: {(prefix.Length == 0 ? "<none>" : prefix)}");
            Console.WriteLine($"SHA-256: {Convert.ToHexString(hash)}");
            Console.WriteLine($"Size: {pbo.Length} bytes");

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"PBO build failed: {ex.Message}");
            return 3;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            PboBuilder - packs a directory into an Arma 3 PBO.

            Usage:
              PboBuilder --source <dir> --output <file.pbo> [options]

            Options:
              --prefix <pbo\\path>       PBO prefix written into the header (default: read
                                         from prefix file, else "x\\<folder>\\addons\\<name>").
              --prefix-file <file>       File that contains the prefix (default: $PBOPREFIX$).
              --exclude <name>           File or directory name/glob to skip (repeatable).
              --hash-file <file>         Write the SHA-256 of the created PBO into <file>.
              --no-prefix                Do not write a prefix.
            """);
    }

    private static string ResolvePrefix(string source, string prefixFile)
    {
        if (prefixFile.Length == 0) return string.Empty;

        string candidate = Path.Combine(source, prefixFile);
        if (File.Exists(candidate))
        {
            string value = File.ReadAllText(candidate).Trim().Trim('\uFEFF');
            return NormalizePrefix(value);
        }

        return string.Empty;
    }

    internal static string NormalizePrefix(string value) =>
        value.Replace('/', '\\').Trim().Trim('\\');

    private static List<PboEntry> CollectEntries(string source, List<string> additionalPrefixFiles, List<string> excludes)
    {
        var entries = new List<PboEntry>();

        var files = Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories)
            .Select(path => new { Full = path, Relative = Path.GetRelativePath(source, path) })
            .Where(file => !IsExcluded(file.Relative, excludes))
            .Where(file => !additionalPrefixFiles.Contains(Path.GetFileName(file.Relative), StringComparer.OrdinalIgnoreCase))
            .OrderBy(file => file.Relative.Replace('/', '\\'), StringComparer.OrdinalIgnoreCase);

        foreach (var file in files)
        {
            string relative = file.Relative.Replace('/', '\\');
            var info = new FileInfo(file.Full);

            entries.Add(new PboEntry(relative, file.Full, PackingMethod.Uncompressed, (uint)info.Length, ToFileTime(info.LastWriteTimeUtc)));
        }

        return entries;
    }

    private static bool IsExcluded(string relativePath, List<string> excludes)
    {
        if (excludes.Count == 0) return false;

        string normalized = relativePath.Replace('/', '\\');
        string fileName = Path.GetFileName(normalized);

        foreach (string exclude in excludes)
        {
            if (string.Equals(exclude, fileName, StringComparison.OrdinalIgnoreCase)) return true;
            if (normalized.StartsWith(exclude.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(normalized, exclude, StringComparison.OrdinalIgnoreCase)) return true;

            try
            {
                if (System.IO.Enumeration.FileSystemName.MatchesSimpleExpression(exclude, normalized, ignoreCase: true)
                    || System.IO.Enumeration.FileSystemName.MatchesSimpleExpression(exclude, fileName, ignoreCase: true))
                    return true;
            }
            catch (ArgumentException)
            {
                // Invalid glob, treat as literal.
            }
        }

        return false;
    }

    internal static byte[] BuildPbo(IReadOnlyList<PboEntry> entries, string prefix)
    {
        using var result = new MemoryStream();
        using var writer = new BinaryWriter(result, Encoding.UTF8, leaveOpen: true);

        // --- Header ---
        writer.Write((byte)0x00);
        writer.Write(Encoding.ASCII.GetBytes("sreV"));
        writer.Write(new byte[16]); // frame header

        if (prefix.Length > 0)
        {
            byte[] prefixBytes = Encoding.UTF8.GetBytes(prefix);
            string folderName = prefix.Contains('\\') ? prefix[(prefix.LastIndexOf('\\') + 1)..] : string.Empty;

            // AddonBuilder style name field: "prefix\0<last folder>\0" padded to 16 bytes.
            byte[] nameField = new byte[16];
            int offset = 0;
            WriteZString(nameField, ref offset, "prefix");
            WriteZString(nameField, ref offset, folderName);

            WriteHeaderEntry(writer, nameField, PackingMethod.Uncompressed, (uint)prefixBytes.Length, ToFileTime(DateTime.UtcNow));
            writer.Write(prefixBytes);
        }

        foreach (var entry in entries)
            WriteHeaderEntry(writer, Encoding.UTF8.GetBytes(entry.RelativePath), entry.Method, entry.OriginalSize, entry.TimeStamp);

        // Terminator entry: empty name, 16 zero bytes.
        writer.Write((byte)0x00);
        writer.Write(new byte[16]);

        // --- Payloads (same order as the header) ---
        foreach (var entry in entries)
        {
            using var input = File.OpenRead(entry.SourcePath);
            input.CopyTo(result);
        }

        writer.Flush();
        return result.ToArray();
    }

    private static void WriteZString(byte[] buffer, ref int offset, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);

        int length = Math.Min(bytes.Length, Math.Max(0, buffer.Length - offset - 1));
        Array.Copy(bytes, 0, buffer, offset, length);
        offset += length;

        if (offset < buffer.Length)
        {
            buffer[offset] = 0;
            offset++;
        }
    }

    private static void WriteHeaderEntry(BinaryWriter writer, byte[] name, PackingMethod method, uint size, uint timeStamp)
    {
        if (name.Length <= 16)
        {
            writer.Write(name);
            for (int i = name.Length; i < 16; i++) writer.Write((byte)0x00);
        }
        else
        {
            // Names longer than the 16 byte field continue directly in the stream.
            writer.Write(name);
            writer.Write((byte)0x00);
        }

        writer.Write((uint)method);
        writer.Write(size);                 // original size
        writer.Write(timeStamp);
        writer.Write(size);                 // stored size (uncompressed)
    }

    /// <summary>
    /// AddonBuilder stores the raw FILETIME low dword in the time field, so the same
    /// representation is used here.
    /// </summary>
    internal static uint ToFileTime(DateTime utc) => (uint)(utc.ToFileTimeUtc() & 0xFFFFFFFF);
}

internal sealed class Options
{
    public string Source { get; private init; } = string.Empty;
    public string Output { get; private init; } = string.Empty;
    public string PrefixFile { get; private init; } = "$PBOPREFIX$";
    public string HashFile { get; private init; } = string.Empty;
    public List<string> Prefixes { get; } = [];
    public List<string> Excludes { get; } = [];

    public static Options Parse(string[] args)
    {
        var options = new OptionsBuilder();

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];

            string Next()
            {
                if (i + 1 >= args.Length) throw new ArgumentException($"Missing value for '{arg}'.");
                return args[++i];
            }

            switch (arg)
            {
                case "--source": options.Source = Next(); break;
                case "--output": options.Output = Next(); break;
                case "--prefix": options.Prefix = Next(); break;
                case "--prefix-file": options.PrefixFile = Next(); break;
                case "--hash-file": options.HashFile = Next(); break;
                case "--exclude": options.Excludes.Add(Next()); break;
                case "--no-prefix": options.Prefix = string.Empty; break;
                default: throw new ArgumentException($"Unknown option '{arg}'.");
            }
        }

        return options.Build();
    }

    private sealed class OptionsBuilder
    {
        public string Source { get; set; } = string.Empty;
        public string Output { get; set; } = string.Empty;
        public string? Prefix { get; set; }
        public string PrefixFile { get; set; } = "$PBOPREFIX$";
        public string HashFile { get; set; } = string.Empty;
        public List<string> Excludes { get; } = [];

        public Options Build()
        {
            if (Source.Length == 0) throw new ArgumentException("--source is required.");
            if (Output.Length == 0) throw new ArgumentException("--output is required.");

            string derivedPrefix = Prefix ?? Program.NormalizePrefix(DerivePrefix(Source));

            var options = new Options {
                Source = Source,
                Output = Output,
                PrefixFile = Prefix is "" ? string.Empty : PrefixFile,
                HashFile = HashFile
            };

            if (derivedPrefix.Length > 0) options.Prefixes.Add(derivedPrefix);
            foreach (string exclude in Excludes) options.Excludes.Add(exclude);

            return options;
        }

        /// <summary>Mirrors AddonBuilder: x\&lt;parent folder&gt;\addons\&lt;addon folder&gt;.</summary>
        private static string DerivePrefix(string source)
        {
            string addonName = Path.GetFileName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(source)));
            string? group = Path.GetFileName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(source))));
            return string.IsNullOrEmpty(group) ? addonName : $"x\\{group.ToLowerInvariant()}\\addons\\{addonName.ToLowerInvariant()}";
        }
    }
}
