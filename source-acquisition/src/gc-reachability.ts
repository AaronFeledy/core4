import { lstat, readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { displaySource } from "./errors.ts";
import { type StoredRecord, detail, names } from "./gc-inventory.ts";
import { type GcRoot, LockKeysResult } from "./gc-schema.ts";
import { io, keyId, processIsAlive } from "./storage.ts";
import { containedPath } from "./tree.ts";
import type { SourceKey } from "./types.ts";

const Lease = Schema.Struct({
  pid: Schema.Number,
  token: Schema.String,
  createdAt: Schema.Number,
  keys: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("git"),
        commit: Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/u)),
      }),
      Schema.Struct({
        kind: Schema.Literal("archive"),
        sha256: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u)),
      }),
    ]),
  ),
});
export interface LeaseFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtime: number;
  readonly live: boolean;
  readonly pid?: number;
  readonly error?: string;
  readonly keys: readonly SourceKey[];
}
export const leases = Effect.fn("SourceGc.leases")(function* (root: string) {
  const rows: LeaseFile[] = [];
  for (const name of yield* io("leases", () => names(containedPath(root, ".leases")))) {
    if (!name.endsWith(".json")) continue;
    const path = containedPath(root, ".leases", name);
    const inspected = yield* Effect.result(io(name, () => lstat(path)));
    if (inspected._tag === "Failure") {
      rows.push({ path, name, bytes: 0, mtime: 0, live: true, keys: [], error: detail(inspected.failure) });
      continue;
    }
    const stats = inspected.success;
    const base = { path, name, bytes: stats.size, mtime: stats.mtimeMs };
    const result = yield* Effect.result(
      io("lease", async () => {
        if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Lease is not a regular file.");
        const data = Schema.decodeUnknownSync(Schema.fromJsonString(Lease))(await readFile(path, "utf8"));
        return {
          ...base,
          pid: data.pid,
          live: processIsAlive(data.pid),
          keys: data.keys,
        };
      }),
    );
    switch (result._tag) {
      case "Success":
        rows.push(result.success);
        break;
      case "Failure":
        rows.push({ ...base, live: true, keys: [], error: detail(result.failure) });
        break;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  return rows;
});
export const leasedKeys = (rows: readonly LeaseFile[]): ReadonlySet<string> =>
  new Set(rows.flatMap((row) => (row.live ? row.keys.map((key) => `${key.kind}/${keyId(key)}`) : [])));
export const reachability = Effect.fn("SourceGc.reachability")(function* (
  records: readonly StoredRecord[],
  readLockKeys: (lockfile: string) => Effect.Effect<LockKeysResult>,
) {
  const git = new Set<string>();
  const npm = new Set<string>();
  const indexed = new Set<string>();
  const roots: GcRoot[] = [];
  let incomplete = false;
  let unknownArchives = false;
  for (const row of records) {
    switch (row.kind) {
      case "npm-index":
        indexed.add(row.value.sha256);
        break;
      case "ref":
        break;
      case "failed":
        if (row.keyKind === "npm-index") {
          unknownArchives = true;
          incomplete = true;
        }
        if (row.keyKind === "root") {
          incomplete = true;
          roots.push({ lockfile: displaySource(row.path), status: "corrupt", detail: row.reason });
        }
        break;
      case "root": {
        const observation = yield* readLockKeys(row.value.lockfile);
        const result: LockKeysResult = Schema.is(LockKeysResult)(observation)
          ? observation
          : { status: "corrupt", detail: "Lockfile contains invalid pinned source identities." };
        roots.push({
          lockfile: displaySource(row.value.lockfile),
          status: result.status,
          ...("detail" in result ? { detail: displaySource(result.detail) } : {}),
        });
        switch (result.status) {
          case "ok":
            for (const key of result.keys) {
              switch (key.kind) {
                case "git":
                  git.add(key.commit);
                  break;
                case "npm":
                  npm.add(`${key.name}\0${key.version}`);
                  break;
                default: {
                  const exhaustive: never = key;
                  return exhaustive;
                }
              }
            }
            break;
          case "missing":
            break;
          case "unreadable":
          case "corrupt":
            incomplete = true;
            break;
          default: {
            const exhaustive: never = result;
            return exhaustive;
          }
        }
        break;
      }
      default: {
        const exhaustive: never = row;
        return exhaustive;
      }
    }
  }
  const archives = new Set(
    records.flatMap((row) =>
      row.kind === "npm-index" && npm.has(`${row.value.name}\0${row.value.version}`)
        ? [row.value.sha256]
        : [],
    ),
  );
  return { git, archives, indexed, roots, incomplete, unknownArchives };
});
export type Reachability = Effect.Success<ReturnType<typeof reachability>>;
