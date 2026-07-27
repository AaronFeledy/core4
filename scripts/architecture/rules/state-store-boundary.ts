import type { Diagnostic, Rule } from "../types.ts";

const SIGNALS = ["atomic-write-rename", "lockfile", "version-envelope"] as const;

const hasAtomicWriteRenameSignal = (sourceText: string): boolean => {
  const hasTempWrite =
    /writeFile(?:Sync)?\s*\([^)]*(?:\.tmp-|tmp-\$\{|temp(?:Path|File|Name)?)/su.test(sourceText) ||
    /(?:\.tmp-|tmp-\$\{)/u.test(sourceText) ||
    /const\s+temp(?:Path|File|Name)?\s*=|let\s+temp(?:Path|File|Name)?\s*=/u.test(sourceText);
  const hasWrite = /writeFile(?:Sync)?\s*\(/u.test(sourceText);
  const hasRename = /rename(?:Sync)?\s*\(/u.test(sourceText);
  return hasTempWrite && hasWrite && hasRename;
};

const hasLockfileSignal = (sourceText: string): boolean => {
  if (/\bO_EXCL\b/u.test(sourceText)) return true;
  if (/\bopen(?:Sync)?\s*\([^)]*(["'`])wx\1/su.test(sourceText)) return true;

  const hasLockPath = /\.lock\b/u.test(sourceText);
  const hasLockLifecycle = /\b(?:unlink|unlinkSync)\s*\(|\bEEXIST\b/u.test(sourceText);
  return hasLockPath && hasLockLifecycle;
};

const hasVersionEnvelopeSignal = (sourceText: string): boolean => {
  if (/JSON\.stringify\s*\(\s*\{\s*version\b/su.test(sourceText)) return true;
  if (/\{\s*version\s*,\s*data\s*\}/su.test(sourceText)) return true;

  const hasMagicHeader =
    /MAGIC|magic header|HEADER_BYTES|writeBigUInt(?:32|64)BE|readBigUInt(?:32|64)BE/u.test(sourceText);
  const hasVersionBody = /schemaVersion|CACHE_SCHEMA_VERSION|\bversion\b/u.test(sourceText);
  return hasMagicHeader && hasVersionBody;
};

const analyzeSource = (file: string, sourceText: string): ReadonlyArray<Diagnostic> => {
  const signals = [
    ...(hasAtomicWriteRenameSignal(sourceText) ? [SIGNALS[0]] : []),
    ...(hasLockfileSignal(sourceText) ? [SIGNALS[1]] : []),
    ...(hasVersionEnvelopeSignal(sourceText) ? [SIGNALS[2]] : []),
  ];

  return signals.length === SIGNALS.length
    ? [{ ruleId: "state-store-boundary", file, message: signals.join(", ") }]
    : [];
};

export const stateStoreBoundaryRule: Rule = {
  id: "state-store-boundary",
  title: "State-store boundary",
  failureHeadline:
    "State-store boundary check failed. Durable atomic-write + lockfile + version-envelope logic must route through core/src/state/.",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (
      await Promise.all(
        files.map(async (file) => analyzeSource(file.relativePath, await context.sourceText(file))),
      )
    ).flat();
  },
};
