using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace SqfReloader;

/// <summary>
/// Arma 3 "simplified array" (SQF literal) reader and writer used on both the
/// <c>callExtension</c> boundary and for extension -> game callbacks.
/// </summary>
internal static class SimpleSerializer {
    #region Writing C# -> Arma

    public static string PrintArray(object?[]? values) => ToArma(values);

    public static string ToArma(object? value) => value switch {
        null => "nil",
        string s => Quote(s),
        char c => Quote(c.ToString()),
        bool b => b ? "true" : "false",
        Enum e => Quote(e.ToString()),
        int or long or short or byte or sbyte or uint or ulong or ushort => Convert.ToString(value, CultureInfo.InvariantCulture)!,
        float f => f.ToString("0.0########", CultureInfo.InvariantCulture),
        double d => d.ToString("0.0########", CultureInfo.InvariantCulture),
        decimal m => m.ToString(CultureInfo.InvariantCulture),
        IDictionary dictionary => ToArmaDictionary(dictionary),
        IEnumerable sequence and not string => ToArmaSequence(sequence),
        _ => Quote(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "")
    };

    // SQF treats backslashes in quoted strings literally (also for preprocess paths).
    // Doubling them here survives parseSimpleArray and changes the actual path seen by SQF.
    private static string Quote(string value) => $"\"{value.Replace("\"", "\"\"")}\"";

    private static string ToArmaSequence(IEnumerable sequence) =>
        "[" + string.Join(",", sequence.Cast<object?>().Select(ToArma)) + "]";

    private static string ToArmaDictionary(IDictionary dictionary) =>
        "[" + string.Join(",", dictionary.Cast<DictionaryEntry>()
            .Select(e => $"[\"{e.Key}\",{ToArma(e.Value)}]")) + "]";

    #endregion

    #region Reading Arma -> C#

    /// <summary>Parses any Arma literal: array, quoted string, number, bool or nil.</summary>
    public static object? Parse(string value) {
        if (value == null) return null;

        string text = value.Trim();
        if (text.Length == 0) return string.Empty;

        if (text[0] == '[') return ParseArray(text);
        if (text[0] == '"') return ParseString(text);

        if (text.Equals("nil", StringComparison.OrdinalIgnoreCase) || text.Equals("null", StringComparison.OrdinalIgnoreCase))
            return null;
        if (text.Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
        if (text.Equals("false", StringComparison.OrdinalIgnoreCase)) return false;

        if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long integer))
            return integer;

        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double number))
            return number;

        return text;
    }

    private static object?[] ParseArray(string text) {
        var items = new List<object?>();

        int depth = 0;
        bool inString = false;
        int start = 1;

        for (int i = 1; i < text.Length; i++) {
            char c = text[i];

            if (inString) {
                if (c == '\\') { i++; continue; }
                if (c == '"') inString = false;
                continue;
            }

            switch (c) {
                case '"':
                    inString = true;
                    break;
                case '[':
                    depth++;
                    break;
                case ']':
                    if (depth == 0) {
                        if (i > start) items.Add(Parse(text[start..i]));
                        return items.ToArray();
                    }
                    depth--;
                    break;
                case ',':
                    if (depth == 0) {
                        items.Add(Parse(text[start..i]));
                        start = i + 1;
                    }
                    break;
            }
        }

        return items.ToArray();
    }

    private static string ParseString(string text) {
        if (text.Length < 2) return text;

        var sb = new StringBuilder(text.Length);
        for (int i = 1; i < text.Length - 1; i++) {
            char c = text[i];

            if (c == '\\' && i + 1 < text.Length - 1) {
                sb.Append(text[++i]);
            } else if (c == '"' && i + 1 < text.Length - 1 && text[i + 1] == '"') {
                i++;
                sb.Append('"');
            } else {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Converts a parsed Arma value to the declared CLR parameter type so callExtension
    /// arguments arrive as the types the method signature asks for.
    /// </summary>
    public static object? Coerce(object? value, Type target) {
        Type type = Nullable.GetUnderlyingType(target) ?? target;

        if (value == null)
            return type.IsValueType ? Activator.CreateInstance(type) : null;

        if (type == typeof(object)) return value;
        if (type.IsInstanceOfType(value)) return value;

        if (type == typeof(string)) return value.ToString() ?? string.Empty;
        if (type == typeof(bool)) return value switch {
            bool b => b,
            string s => s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1",
            _ => Convert.ToDouble(value, CultureInfo.InvariantCulture) != 0
        };
        if (type == typeof(char)) return value.ToString() is { Length: > 0 } s ? s[0] : '\0';
        if (type.IsEnum) return Enum.Parse(type, value.ToString() ?? string.Empty, true);

        if (type.IsArray) {
            var elements = value as object?[] ?? [value];
            var elementType = type.GetElementType()!;
            Array array = Array.CreateInstance(elementType, elements.Length);
            for (int i = 0; i < elements.Length; i++) array.SetValue(Coerce(elements[i], elementType), i);
            return array;
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>)) {
            var elementType = type.GetGenericArguments()[0];
            var list = (IList)Activator.CreateInstance(type)!;
            foreach (object? element in value as object[] ?? [value]) list.Add(Coerce(element, elementType));
            return list;
        }

        if (type == typeof(Dictionary<string, object?>) || type == typeof(IDictionary<string, object?>)) {
            var dictionary = new Dictionary<string, object?>();
            foreach (object? entry in value as object[] ?? []) {
                if (entry is object[] { Length: >= 2 } pair)
                    dictionary[pair[0]?.ToString() ?? string.Empty] = pair.Length == 2 ? pair[1] : pair[1..];
            }
            return dictionary;
        }

        return Convert.ChangeType(value, type, CultureInfo.InvariantCulture);
    }

    #endregion
}
