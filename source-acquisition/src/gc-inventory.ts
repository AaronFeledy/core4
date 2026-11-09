import { lstat, readFile, readdir } from "node:fs/promises";
import { mapFailures } from "@lando/sdk/command-result";
import { isErrnoCode } from "@lando/sdk/errors";
import type { StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import { type SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { EntryRecord, NpmIndexRecord, RefRecord, RootRecord } from "./records.ts";
import { io, keyId } from "./storage.ts";
import { containedPath } from "./tree.ts";
import type { SourceKey } from "./types.ts";

export const iso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));
export const detail = (error: SourceAcquisitionError): string =>
  displaySource(error.message || error.remediation);
export const names = async (path: string): Promise<string[]> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw acquisitionError("cache", path, "Expected a directory, not a symlink or file.");
    return (await readdir(path)).sort();
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return [];
    throw cause;
  }
};
export const bytesIn = async (path: string): Promise<number> => {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return stats.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await bytesIn(containedPath(path, name));
  return bytes;
};
export interface PhysicalEntry {
  readonly key: SourceKey;
  readonly path: string;
  readonly bytes: number;
  readonly mtime: number;
  readonly valid: boolean;
  readonly error?: string;
}
export const inspectEntry = async (root: string, key: SourceKey): Promise<PhysicalEntry> => {
  const id = keyId(key);
  const parent = await lstat(containedPath(root, key.kind));
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw acquisitionError("cache", key.kind, "Source entry parent is not a regular directory.");
  const path = containedPath(root, key.kind, id);
  const stats = await lstat(path);
  const bytes = await bytesIn(path);
  let mtime = stats.mtimeMs;
  let valid = false;
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    try {
      const recordPath = containedPath(path, "entry.json");
      const recordStats = await lstat(recordPath);
      if (recordStats.isFile() && !recordStats.isSymbolicLink()) {
        const value: unknown = JSON.parse(await readFile(recordPath, "utf8"));
        valid = Schema.is(EntryRecord)(value) && value.kind === key.kind && value.id === id;
        if (valid) {
          const tree = await lstat(containedPath(path, "tree"));
          valid = tree.isDirectory() && !tree.isSymbolicLink();
        }
        if (valid) mtime = recordStats.mtimeMs;
      }
    } catch (cause) {
      if (!isErrnoCode(cause, "ENOENT") && !(cause instanceof SyntaxError)) throw cause;
    }
  }
  return { key, path, bytes, mtime, valid };
};
export type RecordKind = "npm-index" | "ref" | "root";
interface RecordFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly mtime: number;
}
export type StoredRecord = RecordFile &
  (
    | { readonly kind: "npm-index"; readonly value: typeof NpmIndexRecord.Type }
    | { readonly kind: "ref"; readonly value: typeof RefRecord.Type }
    | { readonly kind: "root"; readonly value: typeof RootRecord.Type }
    | { readonly kind: "failed"; readonly keyKind: RecordKind; readonly reason: string }
  );
const recordBucket = <A, I>(
  input: { readonly state: StateStoreShape; readonly key: string },
  schema: Schema.Codec<A, I>,
) =>
  input.state
    .open({
      root: "userCache",
      namespace: "sources",
      key: input.key,
      // A corrupt record decodes to null and is reported as a failed row, so GC stays fail-closed.
      schema: Schema.NullOr(schema),
      default: null,
      version: 1,
      onCorrupt: "discard",
    })
    .pipe(mapFailures((cause) => acquisitionError("cache", input.key, cause)));
export const metadata = Effect.fn("SourceGc.metadata")(function* (root: string, state: StateStoreShape) {
  const files = yield* io(root, () => names(root));
  const records: StoredRecord[] = [];
  for (const name of files) {
    const match = /^(npm|ref|root)-[a-f\d]{64}$/u.exec(name);
    if (match === null) continue;
    const prefix = match[1];
    const keyKind: RecordKind = prefix === "npm" ? "npm-index" : prefix === "ref" ? "ref" : "root";
    const path = containedPath(root, name);
    const checked = yield* Effect.result(io(name, () => lstat(path)));
    if (checked._tag === "Failure") {
      records.push({
        name,
        path,
        bytes: 0,
        mtime: 0,
        kind: "failed",
        keyKind,
        reason: detail(checked.failure),
      });
      continue;
    }
    const stats = checked.success;
    const base = { name, path, bytes: stats.size, mtime: stats.mtimeMs };
    const read = <A, I>(schema: Schema.Codec<A, I>) =>
      recordBucket({ state, key: name }, schema).pipe(
        Effect.flatMap((bucket) => bucket.get),
        mapFailures((cause) => acquisitionError("cache", name, cause)),
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(acquisitionError("cache", name, "Missing or unsupported source record."))
            : Effect.succeed(value),
        ),
      );
    if (!stats.isFile() || stats.isSymbolicLink()) {
      records.push({ ...base, kind: "failed", keyKind, reason: "Source record is not a regular file." });
      continue;
    }
    const result = yield* Effect.result(
      Effect.gen(function* (): Effect.fn.Return<StoredRecord, SourceAcquisitionError> {
        switch (keyKind) {
          case "npm-index":
            return { ...base, kind: keyKind, value: yield* read(NpmIndexRecord) };
          case "ref":
            return { ...base, kind: keyKind, value: yield* read(RefRecord) };
          case "root":
            return { ...base, kind: keyKind, value: yield* read(RootRecord) };
          default: {
            const exhaustive: never = keyKind;
            return exhaustive;
          }
        }
      }),
    );
    switch (result._tag) {
      case "Success":
        records.push(result.success);
        break;
      case "Failure":
        records.push({ ...base, kind: "failed", keyKind, reason: detail(result.failure) });
        break;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  return records;
});
