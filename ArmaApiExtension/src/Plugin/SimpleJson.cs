using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ArmaApi;

/// <summary>
/// Small hand written JSON reader/writer. The extension must stay trimming and
/// NativeAOT friendly, so no reflection based (de)serializers are used for the
/// REST payloads and the config file.
/// </summary>
internal static class SimpleJson {
    public static bool TryParse(string json, out Dictionary<string, object?>? value, out string error) {
        value = null;
        error = string.Empty;

        try {
            int index = 0;
            if (ParseValue(json, ref index) is not Dictionary<string, object?> map) {
                error = "value is not an object";
                return false;
            }

            value = map;
            return true;
        } catch (Exception ex) {
            error = ex.Message;
            return false;
        }
    }

    public static bool TryParse(string json, out Dictionary<string, object?>? value) =>
        TryParse(json, out value, out _);

    public static string Serialize(object? value) {
        var sb = new StringBuilder(256);
        WriteValue(sb, value);
        return sb.ToString();
    }

    private static object? ParseValue(string s, ref int i) {
        SkipWhitespace(s, ref i);
        if (i >= s.Length) throw new FormatException("Unexpected end of JSON.");

        return s[i] switch {
            '{' => ParseObject(s, ref i),
            '[' => ParseArray(s, ref i),
            '"' => ParseString(s, ref i),
            't' => ParseLiteral(s, ref i, "true", true),
            'f' => ParseLiteral(s, ref i, "false", false),
            'n' => ParseNullOrNil(s, ref i),
            _ => ParseNumber(s, ref i)
        };
    }

    private static Dictionary<string, object?> ParseObject(string s, ref int i) {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        i++;

        SkipWhitespace(s, ref i);
        if (i < s.Length && s[i] == '}') { i++; return result; }

        while (i < s.Length) {
            SkipWhitespace(s, ref i);
            string key = ParseString(s, ref i);

            SkipWhitespace(s, ref i);
            if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':' in JSON object.");
            i++;

            result[key] = ParseValue(s, ref i);

            SkipWhitespace(s, ref i);
            if (i >= s.Length) break;

            if (s[i] == ',') { i++; continue; }
            if (s[i] == '}') { i++; return result; }
        }

        throw new FormatException("Unterminated JSON object.");
    }

    private static List<object?> ParseArray(string s, ref int i) {
        var result = new List<object?>();
        i++;

        SkipWhitespace(s, ref i);
        if (i < s.Length && s[i] == ']') { i++; return result; }

        while (i < s.Length) {
            result.Add(ParseValue(s, ref i));

            SkipWhitespace(s, ref i);
            if (i >= s.Length) break;

            if (s[i] == ',') { i++; continue; }
            if (s[i] == ']') { i++; return result; }
        }

        throw new FormatException("Unterminated JSON array.");
    }

    private static string ParseString(string s, ref int i) {
        if (s[i] != '"') throw new FormatException("Expected a JSON string.");
        i++;

        var sb = new StringBuilder();
        while (i < s.Length) {
            char c = s[i++];

            if (c == '"') return sb.ToString();
            if (c != '\\') { sb.Append(c); continue; }
            if (i >= s.Length) break;

            char escape = s[i++];
            switch (escape) {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    if (i + 4 > s.Length) throw new FormatException("Invalid unicode escape.");
                    sb.Append((char)int.Parse(s.AsSpan(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                    i += 4;
                    break;
                default: throw new FormatException("Invalid escape (char code " + (int)escape + ").");
            }
        }

        throw new FormatException("Unterminated JSON string.");
    }

    private static object ParseNumber(string s, ref int i) {
        int start = i;

        if (i < s.Length && s[i] == '-') i++;
        while (i < s.Length && (char.IsDigit(s[i]) || s[i] is '.' or 'e' or 'E' or '+' or '-')) i++;

        string token = s[start..i];

        if (long.TryParse(token, NumberStyles.Integer, CultureInfo.InvariantCulture, out long integer))
            return integer;

        if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out double number))
            return number;

        throw new FormatException($"Invalid JSON number '{token}'.");
    }

    /// <summary>
    /// JSON <c>null</c> and the SQF spelling <c>nil</c> are both accepted; SQF tooling
    /// routinely posts payloads copied straight out of a <c>diag_log</c> line.
    /// </summary>
    private static object? ParseNullOrNil(string s, ref int i) {
        if (Matches(s, i, "null")) return ParseLiteral(s, ref i, "null", null);
        if (Matches(s, i, "nil")) return ParseLiteral(s, ref i, "nil", null);

        throw new FormatException($"Expected 'null' at {i}.");
    }

    private static bool Matches(string s, int index, string literal) {
        if (index + literal.Length > s.Length) return false;

        for (int offset = 0; offset < literal.Length; offset++)
            if (s[index + offset] != literal[offset]) return false;

        return true;
    }

    private static object? ParseLiteral(string s, ref int i, string literal, object? value) {
        bool matches = true;

        for (int offset = 0; offset < literal.Length; offset++) {
            if (i + offset >= s.Length) { matches = false; break; }
            if (s[i + offset] != literal[offset]) { matches = false; break; }
        }

        if (!matches) throw new FormatException($"Expected '{literal}' at {i} in '{s}'.");

        i += literal.Length;
        return value;
    }

    private static void SkipWhitespace(string s, ref int i) {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    }

    private static void WriteValue(StringBuilder sb, object? value) {
        switch (value) {
            case null: sb.Append("null"); break;
            case string text: WriteString(sb, text); break;
            case bool flag: sb.Append(flag ? "true" : "false"); break;
            case char character: WriteString(sb, character.ToString()); break;
            case int or long or short or byte or sbyte or uint or ulong or ushort or nint or nuint:
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                break;
            case float f: sb.Append(f.ToString("R", CultureInfo.InvariantCulture)); break;
            case double d: sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); break;
            case decimal m: sb.Append(m.ToString(CultureInfo.InvariantCulture)); break;
            case IDictionary dictionary: WriteDictionary(sb, dictionary); break;
            case IEnumerable sequence: WriteSequence(sb, sequence); break;
            default: WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty); break;
        }
    }

    private static void WriteDictionary(StringBuilder sb, IDictionary dictionary) {
        sb.Append('{');
        bool first = true;

        foreach (DictionaryEntry entry in dictionary) {
            if (!first) sb.Append(',');
            first = false;

            WriteString(sb, Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? string.Empty);
            sb.Append(':');
            WriteValue(sb, entry.Value);
        }

        sb.Append('}');
    }

    private static void WriteSequence(StringBuilder sb, IEnumerable sequence) {
        sb.Append('[');
        bool first = true;

        foreach (object? item in sequence) {
            if (!first) sb.Append(',');
            first = false;
            WriteValue(sb, item);
        }

        sb.Append(']');
    }

    private static void WriteString(StringBuilder sb, string value) {
        sb.Append('"');

        foreach (char c in value) {
            switch (c) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        sb.Append(c);
                    break;
            }
        }

        sb.Append('"');
    }
}
