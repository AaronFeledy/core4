import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface LibpodPrefixOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface LibpodPrefixResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<LibpodPrefixOffender>;
}

interface CheckLibpodPrefixOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["plugins"] as const;

// The Podman 6 libpod API prefix is `/v6.0.0`; any `/v5.<minor>.<patch>` prefix
// constructed in production provider code is a stale Podman 5 API target.
const PODMAN_5_PREFIX = /\/v5\.\d+\.\d+/g;

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only production source is in scope; test fixtures may reference the
        // Podman 5 prefix to prove the runtime floor rejects it.
        if (entry.name === "test") continue;
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

const scanFile = async (file: string): Promise<ReadonlyArray<LibpodPrefixOffender>> => {
  const sourceText = await Bun.file(file).text();
  const offenders: LibpodPrefixOffender[] = [];

  const lines = sourceText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? "";
    for (const match of lineText.matchAll(PODMAN_5_PREFIX)) {
      offenders.push({ file, line: index + 1, match: match[0] });
    }
  }

  return offenders;
};

export const checkLibpodPrefix = async (
  options: CheckLibpodPrefixOptions = {},
): Promise<LibpodPrefixResult> => {
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
        const found = await scanFile(file);
        return found.map((offender) => ({ ...offender, file: relativeFile }));
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (offender: LibpodPrefixOffender): string =>
  `${offender.file}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkLibpodPrefix({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("libpod API prefix check passed.\n");
  } else {
    process.stderr.write(
      `libpod API prefix check failed. Production provider code must target the Podman 6 libpod API prefix (/v6.0.0), not a Podman 5 prefix (/v5.x.x). Migrate the offending prefixes:\n${result.offenders
        .map(formatOffender)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
