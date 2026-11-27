/**
 * Developer cache of container helper builds, shared by every checkout and worktree of one user.
 *
 * An entry is the build output of `build:container-helper` keyed by the helper source digest:
 * `<userCacheRoot>/dev/container-helper/<digest>/` holds the artifacts plus `entry.json`, which
 * records that digest and the SHA-256 of every file. Entries are staged in a sibling directory
 * and renamed into place, so concurrent publishers never expose a partial entry, and a restore
 * verifies every byte it copies against the record before it writes `dist/source-digest`.
 * Shipped Lando never reads this directory; `dev/` keeps it apart from runtime caches.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONTAINER_HELPER_ARCHES, CONTAINER_HELPER_FILE } from "@lando/container-runtime/container-helper";
import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { Schema } from "effect";

export const CONTAINER_HELPER_BINARY_NAMES = CONTAINER_HELPER_ARCHES.map(
  (arch) => `linux-${arch}/${CONTAINER_HELPER_FILE}`,
);
export const CONTAINER_HELPER_NOTICE_NAMES = [
  "licenses/go/LICENSE",
  "licenses/go/PATENTS",
  "licenses/go/files.json",
];
/** Every build writes these; `licenses/go/PATENTS` exists only when the Go toolchain ships one. */
export const CONTAINER_HELPER_REQUIRED_NAMES = [
  ...CONTAINER_HELPER_BINARY_NAMES,
  "licenses/go/LICENSE",
  "licenses/go/files.json",
];
const SOURCE_DIGEST_FILE = "source-digest";
const ENTRY_RECORD = "entry.json";

const CacheEntryRecord = Schema.Struct({
  sourceDigest: Schema.String,
  files: Schema.Array(Schema.Struct({ name: Schema.String, sha256: Schema.String })),
});
const decodeEntryRecord = Schema.decodeUnknownSync(Schema.fromJsonString(CacheEntryRecord));

export const defaultContainerHelperCacheRoot = (): string =>
  join(makeLandoPaths().roots.userCacheRoot, "dev", "container-helper");

export interface ContainerHelperCacheTarget {
  /** The `core/container-helper/dist` directory of one checkout. */
  readonly dist: string;
  readonly sourceDigest: string;
  readonly cacheRoot: string;
}

export type ContainerHelperRestore =
  | { readonly status: "current" }
  | { readonly status: "restored"; readonly entry: string }
  | { readonly status: "missing"; readonly reason: string };

const isErrno = (cause: unknown, ...codes: ReadonlyArray<string>): boolean =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string" && codes.includes(cause.code);

const readIfPresent = async (path: string): Promise<Uint8Array | undefined> => {
  try {
    return await readFile(path);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return undefined;
    throw cause;
  }
};

const recordedDigest = async (dist: string): Promise<string | undefined> => {
  const bytes = await readIfPresent(join(dist, SOURCE_DIGEST_FILE));
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes).trim();
};

/** Reads an entry and returns its files only when the record and every file hash agree with the digest. */
const readVerifiedEntry = async (
  entry: string,
  sourceDigest: string,
): Promise<ReadonlyMap<string, Uint8Array> | string> => {
  const raw = await readIfPresent(join(entry, ENTRY_RECORD));
  if (raw === undefined) return `no cached build for source digest ${sourceDigest}`;
  let record: typeof CacheEntryRecord.Type;
  try {
    record = decodeEntryRecord(new TextDecoder().decode(raw));
  } catch {
    return `the cached entry record at ${entry} is unreadable`;
  }
  if (record.sourceDigest !== sourceDigest)
    return `the cached entry at ${entry} records source digest ${record.sourceDigest}`;
  const files = new Map<string, Uint8Array>();
  for (const { name, sha256 } of record.files) {
    const bytes = await readIfPresent(join(entry, name));
    if (bytes === undefined || sha256Hex(bytes) !== sha256)
      return `the cached file ${name} in ${entry} is missing or damaged`;
    files.set(name, bytes);
  }
  for (const name of CONTAINER_HELPER_REQUIRED_NAMES)
    if (!files.has(name)) return `the cached entry at ${entry} lacks ${name}`;
  return files;
};

const writeTree = async (root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> => {
  for (const [name, bytes] of files) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
    if (CONTAINER_HELPER_BINARY_NAMES.includes(name)) await chmod(path, 0o755);
  }
};

/**
 * Copies a checkout's current helper build into the cache. Refuses a build whose recorded digest is
 * not `sourceDigest`. Returns `present` when a verified entry already exists, including one a
 * concurrent publisher renamed into place first.
 */
export const publishContainerHelper = async (
  target: ContainerHelperCacheTarget,
): Promise<"published" | "present"> => {
  const recorded = await recordedDigest(target.dist);
  if (recorded !== target.sourceDigest)
    throw new Error(
      `Refusing to cache the helper in ${target.dist}: it records source digest ${recorded ?? "(none)"}, not ${target.sourceDigest}.`,
    );
  const entry = join(target.cacheRoot, target.sourceDigest);
  if (typeof (await readVerifiedEntry(entry, target.sourceDigest)) !== "string") return "present";

  const files = new Map<string, Uint8Array>();
  for (const name of [...CONTAINER_HELPER_BINARY_NAMES, ...CONTAINER_HELPER_NOTICE_NAMES]) {
    const bytes = await readIfPresent(join(target.dist, name));
    if (bytes !== undefined) files.set(name, bytes);
  }
  for (const name of CONTAINER_HELPER_REQUIRED_NAMES)
    if (!files.has(name))
      throw new Error(`Refusing to cache the helper in ${target.dist}: ${name} is missing.`);

  await mkdir(target.cacheRoot, { recursive: true });
  const stage = join(target.cacheRoot, `.stage-${process.pid}-${randomUUID()}`);
  try {
    await writeTree(stage, files);
    const record: typeof CacheEntryRecord.Type = {
      sourceDigest: target.sourceDigest,
      files: [...files].map(([name, bytes]) => ({ name, sha256: sha256Hex(bytes) })),
    };
    await writeFile(join(stage, ENTRY_RECORD), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    try {
      await rename(stage, entry);
      return "published";
    } catch (cause) {
      if (!isErrno(cause, "EEXIST", "ENOTEMPTY", "EPERM")) throw cause;
    }
    // Another publisher won the rename; accept its entry once it verifies.
    if (typeof (await readVerifiedEntry(entry, target.sourceDigest)) !== "string") return "present";
    // A damaged entry sits at the key: move it aside, then publish ours in its place.
    const damaged = join(target.cacheRoot, `.damaged-${process.pid}-${randomUUID()}`);
    await rename(entry, damaged).catch((cause: unknown) => {
      if (!isErrno(cause, "ENOENT")) throw cause;
    });
    await rm(damaged, { recursive: true, force: true });
    try {
      await rename(stage, entry);
      return "published";
    } catch (cause) {
      if (!isErrno(cause, "EEXIST", "ENOTEMPTY", "EPERM")) throw cause;
      if (typeof (await readVerifiedEntry(entry, target.sourceDigest)) !== "string") return "present";
      throw new Error(`The cached helper entry at ${entry} keeps failing verification.`, { cause });
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

/**
 * Makes `dist` hold the helper built from `sourceDigest`. A build that already records that
 * digest is left alone; otherwise a verified cache entry is copied in and `source-digest` is
 * written last, so an interrupted restore never leaves a digest that vouches for other bytes.
 */
export const restoreContainerHelper = async (
  target: ContainerHelperCacheTarget,
): Promise<ContainerHelperRestore> => {
  if ((await recordedDigest(target.dist)) === target.sourceDigest) {
    const present = await Promise.all(
      CONTAINER_HELPER_REQUIRED_NAMES.map((name) => Bun.file(join(target.dist, name)).exists()),
    );
    if (present.every(Boolean)) return { status: "current" };
  }
  const entry = join(target.cacheRoot, target.sourceDigest);
  const files = await readVerifiedEntry(entry, target.sourceDigest);
  if (typeof files === "string") return { status: "missing", reason: files };

  await mkdir(target.dist, { recursive: true });
  const stage = join(dirname(target.dist), `.restore-${process.pid}-${randomUUID()}`);
  try {
    await writeTree(stage, files);
    await rm(join(target.dist, SOURCE_DIGEST_FILE), { force: true });
    for (const name of CONTAINER_HELPER_NOTICE_NAMES)
      if (!files.has(name)) await rm(join(target.dist, name), { force: true });
    for (const name of files.keys()) {
      await mkdir(dirname(join(target.dist, name)), { recursive: true });
      await rename(join(stage, name), join(target.dist, name));
    }
    await writeFile(join(stage, SOURCE_DIGEST_FILE), `${target.sourceDigest}\n`);
    await rename(join(stage, SOURCE_DIGEST_FILE), join(target.dist, SOURCE_DIGEST_FILE));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { status: "restored", entry };
};
