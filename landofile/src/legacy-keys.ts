const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 10000;
const ROOT_KEYS = new Set(["compose", "pluginDirs", "plugins", "excludes"]);
const SERVICE_KEYS = new Set([
  "overrides",
  "build_as_root",
  "run_as_root",
  "build_internal",
  "run_internal",
  "portforward",
]);

/**
 * Failure-only hint, never a dialect parser. Scan at most 1 MiB / 10,000 lines
 * of already-read source. Catalog types, api: 4 and missing runtime are not
 * evidence. Ambiguous native content requires explicit translation.
 */
export const hasLegacyRawKeys = (content: string): boolean => {
  // Slice before encoding so even temporary allocation has a fixed upper bound.
  const bytes = new TextEncoder().encode(content.slice(0, MAX_BYTES));
  const prefix = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES));
  const lines = prefix.split("\n", MAX_LINES);
  const parents: Array<{ readonly indent: number; readonly key: string }> = [];
  let recipe = false;
  let config = false;
  let scalarIndent: number | undefined;
  for (const [index, line] of lines.entries()) {
    // A truncated final line cannot prove a key or scalar value.
    if (index === lines.length - 1 && content.length > prefix.length && !prefix.endsWith("\n")) break;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (scalarIndent !== undefined && indent > scalarIndent) continue;
    scalarIndent = undefined;
    while (parents.length > 0 && (parents.at(-1)?.indent ?? -1) >= indent) parents.pop();
    const match = /^ *(?:([A-Za-z0-9_.-]+)|"([^"\r\n]+)"|'([^'\r\n]+)'):[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? match[2] ?? match[3] ?? "";
    const value = (match[4] ?? "").replace(/\s+#.*$/, "").trim();
    if (indent === 0) {
      if (ROOT_KEYS.has(key)) return true;
      recipe ||= key === "recipe";
      config ||= key === "config";
      if (recipe && config) return true;
    }
    if (parents.length === 2 && parents[0]?.indent === 0) {
      if (
        parents[0].key === "services" &&
        (SERVICE_KEYS.has(key) || (key === "api" && /^(?:3|"3"|'3')$/.test(value)))
      )
        return true;
      if (parents[0].key === "tooling" && key === "options") return true;
    }
    if (value !== "" && !value.startsWith("#")) scalarIndent = indent;
    if (value === "" || value.startsWith("#")) parents.push({ indent, key });
  }
  return false;
};
