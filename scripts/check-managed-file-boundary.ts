import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface ManagedFileBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface ManagedFileBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<ManagedFileBoundaryOffender>;
}

interface CheckManagedFileBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;
const CARVE_OUT_PREFIX = "core/src/managed-file/";

// Sentinels of the one ownership-marker/overwrite implementation. A host-project
// file writer that re-spells these is hand-rolling managed-file logic instead of
// delegating to `ManagedFileService`. `x-lando-generated` is caught by the
// `lando-generated` tag, and the fences are the `block`-mode markers.
const SENTINELS = ["lando-generated", ">>> lando:", "<<< lando:"] as const;

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
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

const scanFile = async (file: string): Promise<ReadonlyArray<ManagedFileBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const offenders: ManagedFileBoundaryOffender[] = [];

  sourceText.split(/\r?\n/u).forEach((text, index) => {
    const hit = SENTINELS.find((sentinel) => text.includes(sentinel));
    if (hit !== undefined) offenders.push({ file, line: index + 1, match: hit });
  });

  return offenders;
};

export const checkManagedFileBoundary = async (
  options: CheckManagedFileBoundaryOptions = {},
): Promise<ManagedFileBoundaryResult> => {
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
        if (relativeFile.startsWith(CARVE_OUT_PREFIX)) return [];
        return scanFile(file);
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: ManagedFileBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkManagedFileBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Managed-file boundary check passed.\n");
  } else {
    process.stderr.write(
      `Managed-file boundary check failed. Host project-file ownership-marker/overwrite logic must route through ManagedFileService (core/src/managed-file/).\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
