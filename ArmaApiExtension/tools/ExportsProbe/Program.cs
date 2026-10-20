// Reads the PE export table of an Arma extension and verifies the RVExtension* entry points.
// Used by tools\smoke-test.ps1.

using System.Text;

namespace ExportsProbe;

internal static class Program
{
    private static readonly string[] Required =
    [
        "RVExtension",
        "RVExtensionArgs",
        "RVExtensionVersion",
        "RVExtensionContext",
        "RVExtensionRegisterCallback"
    ];

    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: ExportsProbe <dll> [--json]");
            return 2;
        }

        try
        {
            using var file = File.OpenRead(args[0]);
            using var reader = new BinaryReader(file);

            List<string> exports = ReadExports(reader);

            Console.WriteLine("Exports:");
            foreach (string name in exports) Console.WriteLine($"  {name}");

            var missing = Required.Where(name => !exports.Contains(name, StringComparer.Ordinal)).ToArray();

            if (args.Contains("--json"))
                Console.WriteLine("{\"exports\":[" + string.Join(",", exports.Select(e => $"\"{e}\"")) + "]}");

            if (missing.Length > 0)
            {
                Console.Error.WriteLine("Missing exports: " + string.Join(", ", missing));
                return 1;
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not read exports: {ex.Message}");
            return 3;
        }
    }

    private static List<string> ReadExports(BinaryReader reader)
    {
        var exports = new List<string>();

        if (reader.ReadUInt16() != 0x5A4D) throw new InvalidDataException("Not a PE file (missing MZ).");

        reader.BaseStream.Position = 0x3C;
        int peOffset = reader.ReadInt32();

        reader.BaseStream.Position = peOffset;
        if (reader.ReadUInt32() != 0x00004550) throw new InvalidDataException("Not a PE file (missing PE signature).");
        reader.ReadUInt16(); // machine
        ushort sectionCount = reader.ReadUInt16();
        reader.ReadUInt32(); // timestamp
        reader.ReadUInt32(); // symbol table
        reader.ReadUInt32(); // symbol count
        ushort optionalHeaderSize = reader.ReadUInt16();
        reader.ReadUInt16(); // characteristics

        reader.BaseStream.Position = peOffset + 24;
        long optionalHeaderStart = peOffset + 24;

        ushort magic = reader.ReadUInt16();
        int dataDirectoryOffset = (int)(optionalHeaderStart + (magic == 0x20B ? 112 : 96));

        // Data directory entry 0 = export table (8 bytes each, 64 bytes before it is out of range).
        reader.BaseStream.Position = dataDirectoryOffset;
        uint exportRva = reader.ReadUInt32();
        reader.ReadUInt32();

        if (exportRva == 0) return exports;

        long sectionHeaders = optionalHeaderStart + optionalHeaderSize;

        var sections = new List<(string Name, uint VirtualAddress, uint RawPointer, uint RawSize)>();

        for (int i = 0; i < sectionCount; i++)
        {
            reader.BaseStream.Position = sectionHeaders + (i * 40);

            byte[] nameBytes = reader.ReadBytes(8);
            string name = System.Text.Encoding.ASCII.GetString(nameBytes).TrimEnd('\0');
            uint virtualSize = reader.ReadUInt32();
            uint virtualAddress = reader.ReadUInt32();
            uint rawSize = reader.ReadUInt32();
            uint rawPointer = reader.ReadUInt32();

            sections.Add((name, virtualAddress, rawPointer, Math.Max(virtualSize, rawSize)));
        }

        long RvaToOffset(uint rva)
        {
            foreach (var section in sections)
            {
                if (rva >= section.VirtualAddress && rva < section.VirtualAddress + section.RawSize)
                    return section.RawPointer + (rva - section.VirtualAddress);
            }

            return rva;
        }

        reader.BaseStream.Position = RvaToOffset(exportRva);

        reader.ReadUInt32(); // characteristics
        reader.ReadUInt32(); // timestamp
        reader.ReadUInt16(); // major
        reader.ReadUInt16(); // minor
        reader.ReadUInt32(); // name rva
        reader.ReadUInt32(); // base
        uint functionCount = reader.ReadUInt32();
        uint nameCount = reader.ReadUInt32();
        reader.ReadUInt32(); // address of functions
        uint nameRva = reader.ReadUInt32();
        reader.ReadUInt32(); // ordinal table

        if (nameCount == 0) return exports;

        long namesOffset = RvaToOffset(nameRva);

        for (int i = 0; i < nameCount; i++)
        {
            reader.BaseStream.Position = namesOffset + (i * 4);
            long nameOffset = RvaToOffset(reader.ReadUInt32());

            reader.BaseStream.Position = nameOffset;
            var builder = new System.Text.StringBuilder();

            while (true)
            {
                char c = (char)reader.ReadByte();
                if (c == '\0') break;
                builder.Append(c);            }

            exports.Add(builder.ToString());
        }

        return exports;
    }
}
