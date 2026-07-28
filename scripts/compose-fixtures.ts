import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { sha256Hex } from "./compose-vendor.ts";

const REPOSITORY = "https://github.com/compose-spec/conformance-tests";
const RAW_PREFIX = "https://raw.githubusercontent.com/compose-spec/conformance-tests";
const LICENSE = "Apache-2.0";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ComposeFixtureEntry {
  readonly path: string;
  readonly vendored: string;
  readonly sha256: string;
}

export interface ComposeFixturePin {
  readonly repo: string;
  readonly ref: string;
  readonly sourceUrlPrefix: string;
  readonly license: string;
  readonly files: ReadonlyArray<ComposeFixtureEntry>;
}

export interface ComposeFixtureSource {
  readonly path: string;
  readonly vendored: string;
  readonly bytes: ArrayBuffer;
}

export interface ComposeFixtureChecksumEntry {
  readonly vendored: string;
  readonly expectedSha256: string;
  readonly actualSha256?: string;
  readonly ok: boolean;
}

export interface ComposeFixtureChecksumResult {
  readonly entries: ReadonlyArray<ComposeFixtureChecksumEntry>;
  readonly missing: ReadonlyArray<string>;
  readonly unpinned: ReadonlyArray<string>;
  readonly ok: boolean;
}

export interface ComposeFixturePaths {
  readonly pinPath: string;
  readonly fixturesRoot: string;
}

export interface ComposeFixtureListOptions {
  readonly fixturesRoot: string;
}

export class ComposeFixturePinError extends Error {
  readonly pinPath: string;

  constructor(pinPath: string) {
    super(`Invalid Compose fixture pin: ${pinPath}`);
    this.name = "ComposeFixturePinError";
    this.pinPath = pinPath;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[a-z]:/iu.test(path) &&
  !path.split(/[\\/]/u).includes("..");

export const composeFixtureSourceUrl = (ref: string, path: string): string => `${RAW_PREFIX}/${ref}/${path}`;

export const parseComposeFixturePin = (value: unknown, pinPath: string): ComposeFixturePin => {
  if (!isRecord(value)) throw new ComposeFixturePinError(pinPath);
  const { repo, ref, sourceUrlPrefix, license, files } = value;
  if (
    repo !== REPOSITORY ||
    typeof ref !== "string" ||
    !COMMIT_PATTERN.test(ref) ||
    typeof sourceUrlPrefix !== "string" ||
    !sourceUrlPrefix.startsWith(`${RAW_PREFIX}/${ref}/`) ||
    license !== LICENSE ||
    !Array.isArray(files)
  ) {
    throw new ComposeFixturePinError(pinPath);
  }

  const vendoredPaths = new Set<string>();
  const parsedFiles: ComposeFixtureEntry[] = [];
  for (const file of files) {
    if (!isRecord(file)) throw new ComposeFixturePinError(pinPath);
    const { path, vendored, sha256 } = file;
    if (
      typeof path !== "string" ||
      !isSafeRelativePath(path) ||
      typeof vendored !== "string" ||
      !isSafeRelativePath(vendored) ||
      vendoredPaths.has(vendored) ||
      typeof sha256 !== "string" ||
      !SHA256_PATTERN.test(sha256)
    ) {
      throw new ComposeFixturePinError(pinPath);
    }
    vendoredPaths.add(vendored);
    parsedFiles.push({ path, vendored, sha256 });
  }

  return { repo, ref, sourceUrlPrefix, license, files: parsedFiles };
};

export const readComposeFixturePin = async (pinPath: string): Promise<ComposeFixturePin> => {
  const parsed: unknown = JSON.parse(await Bun.file(pinPath).text());
  return parseComposeFixturePin(parsed, pinPath);
};

export const buildComposeFixturePin = (
  ref: string,
  files: ReadonlyArray<ComposeFixtureSource>,
): ComposeFixturePin => ({
  repo: REPOSITORY,
  ref,
  sourceUrlPrefix: `${RAW_PREFIX}/${ref}/`,
  license: LICENSE,
  files: files
    .map(({ path, vendored, bytes }) => ({ path, vendored, sha256: sha256Hex(bytes) }))
    .sort((left, right) => left.vendored.localeCompare(right.vendored)),
});

const listFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  await visit(root);
  return files.sort();
};

export const verifyComposeFixtureChecksums = async (
  paths: ComposeFixturePaths,
): Promise<ComposeFixtureChecksumResult> => {
  const pin = await readComposeFixturePin(paths.pinPath);
  const entries: ComposeFixtureChecksumEntry[] = [];
  const missing: string[] = [];
  for (const file of pin.files) {
    const vendoredFile = Bun.file(join(paths.fixturesRoot, file.vendored));
    if (!(await vendoredFile.exists())) {
      missing.push(file.vendored);
      entries.push({ vendored: file.vendored, expectedSha256: file.sha256, ok: false });
      continue;
    }
    const actualSha256 = sha256Hex(await vendoredFile.arrayBuffer());
    entries.push({
      vendored: file.vendored,
      expectedSha256: file.sha256,
      actualSha256,
      ok: actualSha256 === file.sha256,
    });
  }

  const pinned = new Set(pin.files.map((file) => file.vendored));
  const unpinned = (await listFiles(join(paths.fixturesRoot, "upstream")))
    .map((path) => `upstream/${path}`)
    .filter((path) => !pinned.has(path));
  const ok = missing.length === 0 && unpinned.length === 0 && entries.every((entry) => entry.ok);
  return { entries, missing: missing.sort(), unpinned, ok };
};

export const listComposeFixtures = async (
  options: ComposeFixtureListOptions,
): Promise<ReadonlyArray<string>> => {
  const fixtureFiles = await Promise.all(
    ["corpus", "upstream"].map(async (directory) =>
      (await listFiles(join(options.fixturesRoot, directory))).map((path) => `${directory}/${path}`),
    ),
  );
  return fixtureFiles
    .flat()
    .filter((path) => path.endsWith(".compose.yaml"))
    .sort();
};
