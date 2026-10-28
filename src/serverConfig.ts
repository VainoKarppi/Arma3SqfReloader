/** Reads the `hostname = "..."` value of an Arma server config, or "" when it has none. */
export function hostnameValue(content: string): string {
    const match = /^\s*hostname\s*=\s*"((?:[^"\\]|\\.)*)"/im.exec(stripComments(content));
    return match ? match[1].trim() : "";
}

export function hasHostnameAssignment(content: string): boolean {
    return /^\s*hostname\s*=/im.test(stripComments(content));
}

/** Returns the content with comments blanked out, leaving strings and line breaks intact. */
function stripComments(content: string): string {
    let cleaned = "";
    let inBlockComment = false;
    let quote: "\"" | "'" | undefined;

    for (let index = 0; index < content.length; index++) {
        const character = content[index];
        const next = content[index + 1];

        if (inBlockComment) {
            if (character === "*" && next === "/") {
                inBlockComment = false;
                index++;
                cleaned += "  ";
            } else {
                cleaned += character === "\n" || character === "\r" ? character : " ";
            }
            continue;
        }

        if (quote) {
            cleaned += character;
            if (character === "\\" && next) {
                cleaned += next;
                index++;
            } else if (character === quote) {
                quote = undefined;
            }
            continue;
        }

        if (character === "\"" || character === "'") {
            quote = character;
            cleaned += character;
        } else if (character === "/" && next === "/") {
            while (index < content.length && content[index] !== "\n") index++;
            cleaned += "\n";
        } else if (character === "/" && next === "*") {
            inBlockComment = true;
            index++;
            cleaned += "  ";
        } else {
            cleaned += character;
        }
    }

    return cleaned;
}
