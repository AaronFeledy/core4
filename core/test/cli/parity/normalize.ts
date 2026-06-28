/**
 * Shared CLI-output normalization for source↔compiled dispatch parity checks.
 *
 * Both dispatch paths (source-mode OCLIF `execute()` and the compiled `$bunfs`
 * hand-rolled `runCompiledCli`) share command implementations and renderers by
 * construction, so their user-facing output must be semantically identical.
 * Comparing raw bytes is too strict: timestamps, absolute install/cache/log
 * paths, the `version platform-arch node-…` triple, durations, and pids differ
 * run-to-run and between the two binaries. These helpers strip exactly those
 * environment-dependent fragments so the remaining text/structure can be
 * compared for equality.
 *
 * This module is intentionally framework-agnostic (no test runner imports) so
 * future parity checks can reuse it as the divergence-surface contract.
 */

const ESC = 27;
const CSI_FINAL_BYTE_MIN = 0x40;
const CSI_FINAL_BYTE_MAX = 0x7e;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const VERSION_TRIPLE_PATTERN = /\d+\.\d+\.\d+\s+[a-z0-9]+-[a-z0-9]+\s+node-v?[\d.]+/gi;
const SEMVER_PATTERN = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;
const ABSOLUTE_PATH_PATTERN = /(?:\/[A-Za-z0-9._$-]+)+/g;
const DURATION_PATTERN = /\b\d+(?:\.\d+)?\s?(?:ms|s|µs|us|ns)\b/gi;
// Linux appends " (deleted)" to a /proc/self/exe-derived path when the running
// binary's file was replaced (e.g. a test rebuilt dist/lando mid-suite). The
// marker is an OS runtime artifact, not Lando output, so it is dropped.
const PROC_SELF_EXE_DELETED_MARKER = / \(deleted\)/g;

// Char-code scan (not a regex) so the ESC control byte avoids Biome's noControlCharactersInRegex.
export const stripAnsi = (value: string): string => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === ESC && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX) break;
        index += 1;
      }
      continue;
    }
    output += value[index];
  }
  return output;
};

/**
 * Normalize a stderr/stdout blob for cross-path comparison.
 *
 * Order matters: the version triple is collapsed before the generic semver
 * sweep, and absolute paths last so a path containing a version is fully
 * neutralized.
 */
export const normalizeOutput = (value: string): string =>
  stripAnsi(value)
    .replace(PROC_SELF_EXE_DELETED_MARKER, "")
    .replace(ISO_TIMESTAMP_PATTERN, "<TS>")
    .replace(VERSION_TRIPLE_PATTERN, "<VERSION_TRIPLE>")
    .replace(DURATION_PATTERN, "<DUR>")
    .replace(ABSOLUTE_PATH_PATTERN, "<PATH>")
    .replace(SEMVER_PATTERN, "<SEMVER>")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();

/** Field names whose values are environment-dependent and must be dropped before JSON parity. */
const VOLATILE_JSON_KEYS: ReadonlyArray<string> = ["timestamp", "logsDir", "cacheDir"];

/**
 * Strip volatile keys from a parsed JSON-renderer envelope so the stable error
 * can be compared for equality across the two dispatch paths.
 */
export const normalizeJsonEnvelope = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return { __nonObject: String(value) };
  }
  const record = value as Record<string, unknown>;
  if (record._tag === "result" && typeof record.envelope === "object" && record.envelope !== null) {
    return normalizeJsonEnvelope(record.envelope);
  }
  if (record.apiVersion === "v4") {
    const normalized: Record<string, unknown> = {};
    if (typeof record.command === "string") normalized.commandId = record.command;
    if (record.ok === false && typeof record.error === "object" && record.error !== null) {
      const error = record.error as Record<string, unknown>;
      for (const [key, raw] of Object.entries(error)) {
        if (key === "_tag") continue;
        normalized[key] = typeof raw === "string" ? normalizeOutput(raw) : raw;
      }
      if (typeof error._tag === "string") normalized.code = error._tag;
    } else if (Object.hasOwn(record, "result")) {
      normalized.apiVersion = record.apiVersion;
      normalized.command = record.command;
      normalized.ok = record.ok;
      normalized.result = record.result;
    }
    return normalized;
  }
  if (record._tag === "message.error") {
    const normalized: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(record)) {
      if (VOLATILE_JSON_KEYS.includes(key) || key === "_tag" || key === "body") continue;
      normalized[key] = typeof raw === "string" ? normalizeOutput(raw) : raw;
    }
    if (typeof record.body === "string") normalized.message = normalizeOutput(record.body);
    return normalized;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (VOLATILE_JSON_KEYS.includes(key)) continue;
    out[key] = typeof raw === "string" ? normalizeOutput(raw) : raw;
  }
  return out;
};

/** Extract the tagged error `code` from a stderr blob (plain or JSON renderer). */
export const errorCodeFromStderr = (stderr: string): string | undefined => {
  const match = /code:\s*([A-Za-z0-9_]+)/.exec(stderr) ?? /"code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(stderr);
  return match?.[1];
};
