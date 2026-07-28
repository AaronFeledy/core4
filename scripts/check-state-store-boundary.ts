import * as fs from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface StateStoreBoundaryOffender {
  readonly file: string;
  readonly signals: ReadonlyArray<string>;
}

export interface StateStoreBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<StateStoreBoundaryOffender>;
}

interface CheckStateStoreBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;
const CARVE_OUT_PREFIXES = ["core/src/state/"] as const;
const CARVE_OUTS = new Set([
  // Low-level shared atomic cache helper; callers must not re-spell the full
  // StateStore lock + version-envelope contract around it.
  "core/src/cache/atomic.ts",
  // Include lockfile and scratch registry use StateStore-backed codecs rather
  // than owning durable state persistence directly.
  "core/src/landofile/includes.ts",
  "core/src/scratch-app/registry.ts",
  // Canonical StateStore-compatible low-level atomic helper.
  "core/src/state-store/atomic.ts",
]);

const SIGNALS = ["atomic-write-rename", "lockfile", "version-envelope"] as const;

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

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

const scanFile = async (file: string): Promise<ReadonlyArray<StateStoreBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const signals = [
    ...(hasAtomicWriteRenameSignal(sourceText) ? [SIGNALS[0]] : []),
    ...(hasLockfileSignal(sourceText) ? [SIGNALS[1]] : []),
    ...(hasVersionEnvelopeSignal(sourceText) ? [SIGNALS[2]] : []),
  ];

  return signals.length === SIGNALS.length ? [{ file, signals }] : [];
};

export const checkStateStoreBoundary = async (
  options: CheckStateStoreBoundaryOptions = {},
): Promise<StateStoreBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const offenders = (
    await Promise.all(
      files.map(async (file) => {
        const relativeFile = relative(root, file).replaceAll("\\", "/");
        if (CARVE_OUTS.has(relativeFile)) return [];
        if (CARVE_OUT_PREFIXES.some((prefix) => relativeFile.startsWith(prefix))) return [];
        return scanFile(file);
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file));

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: StateStoreBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}: ${offender.signals.join(", ")}`;

if (import.meta.main) {
  const result = await checkStateStoreBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("State-store boundary check passed.\n");
  } else {
    process.stderr.write(
      `State-store boundary check failed. Durable atomic-write + lockfile + version-envelope logic must route through core/src/state/.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
