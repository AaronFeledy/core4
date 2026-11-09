import { lstat, mkdir, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import { Clock, Effect, Schema } from "effect";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { makeLeaseLifecycle } from "./lease-lifecycle.ts";
import { EntryRecord } from "./records.ts";
import { containedPath, realContainedPath, treeDigest } from "./tree.ts";
import type { SourceKey, SourcePin, SourceSnapshot, SourceStoreOptions } from "./types.ts";

export const io = <A>(source: string, body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => acquisitionError("cache", source, cause),
  }).pipe(Effect.uninterruptible);
export const keyId = (key: SourceKey): string => {
  switch (key.kind) {
    case "git":
      return key.commit;
    case "archive":
      return key.sha256;
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
};
export const validKey = (key: SourceKey): boolean => {
  switch (key.kind) {
    case "git":
      return /^[a-f\d]{40}$/u.test(key.commit);
    case "archive":
      return /^[a-f\d]{64}$/u.test(key.sha256);
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
};
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (isErrnoCode(cause, "EPERM")) return true;
    if (isErrnoCode(cause, "ESRCH")) return false;
    throw cause;
  }
};

export const makeStorage = (
  options: SourceStoreOptions,
  root: string,
  lease: { readonly token: string; readonly createdAt: number },
) => {
  const lockKey = `source-cache-${sha256Hex(root)}`;
  const keys = new Map<string, SourceKey>();
  const withLease = makeLeaseLifecycle();
  const leasePath = containedPath(root, ".leases", `${lease.token}.json`);
  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    options.stateStore
      .withLock(lockKey, effect)
      .pipe(mapFailures((error) => acquisitionError("cache", "source store", error)));
  const entryPath = (key: SourceKey) => containedPath(root, key.kind, keyId(key));
  const stage = <A>(body: (directory: string) => Effect.Effect<A, SourceAcquisitionError>) =>
    Effect.acquireUseRelease(
      io("staging", async () => {
        const directory = containedPath(root, `.staging-${process.pid}-${crypto.randomUUID()}`);
        await mkdir(containedPath(directory, "tree"), { recursive: true });
        return directory;
      }),
      body,
      (directory) => io("staging", () => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    );
  const writeLease = (pending?: SourceKey) =>
    stage((directory) =>
      io("lease", async () => {
        const temporary = containedPath(directory, "lease.json");
        await writeFile(
          temporary,
          JSON.stringify({
            pid: process.pid,
            token: lease.token,
            createdAt: lease.createdAt,
            keys: pending === undefined ? [...keys.values()] : [...keys.values(), pending],
          }),
          { mode: 0o600 },
        );
        await rename(temporary, leasePath);
        // Rename is the commit point. Commit memory before stage cleanup can fail
        // or interruption can be delivered; utimes/write/rename failures commit neither.
        if (pending !== undefined) keys.set(`${pending.kind}/${keyId(pending)}`, pending);
      }),
    );
  const register = Effect.fn("SourceSession.register")(function* (key: SourceKey) {
    const id = `${key.kind}/${keyId(key)}`;
    if (keys.has(id)) return;
    const now = yield* Clock.currentTimeMillis;
    yield* io(id, () => utimes(containedPath(entryPath(key), "entry.json"), now / 1000, now / 1000));
    yield* writeLease(key);
  });
  const readEntry = Effect.fn("SourceStore.readEntry")(function* (key: SourceKey) {
    if (!validKey(key))
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: "Invalid physical source key.",
          source: "cache",
          kind: "invalid-locator",
          remediation: "Use a full git commit or SHA-256 digest.",
        }),
      );
    return yield* io(keyId(key), async () => {
      const dir = entryPath(key);
      try {
        if ((await lstat(dir)).isSymbolicLink()) return undefined;
        await realContainedPath(root, dir);
        const recordPath = containedPath(dir, "entry.json");
        if (!(await lstat(recordPath)).isFile() || (await lstat(recordPath)).isSymbolicLink())
          return undefined;
        const parsed: unknown = JSON.parse(await readFile(recordPath, "utf8"));
        if (!Schema.is(EntryRecord)(parsed) || parsed.kind !== key.kind || parsed.id !== keyId(key))
          return undefined;
        const tree = containedPath(dir, "tree");
        if (!(await lstat(tree)).isDirectory() || (await lstat(tree)).isSymbolicLink()) return undefined;
        await realContainedPath(root, tree);
        return parsed;
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT") || cause instanceof SyntaxError) return undefined;
        throw cause;
      }
    });
  });
  /** `verify` recomputes the tree digest so repair-mode callers refetch only entries that changed on disk. */
  const open = <P extends SourcePin>(
    key: SourceKey,
    pin: P,
    options: { readonly verify?: boolean } = {},
  ): Effect.Effect<SourceSnapshot<P> | undefined, SourceAcquisitionError> => {
    const body = Effect.gen(function* () {
      const record = yield* readEntry(key);
      if (record === undefined) return undefined;
      yield* register(key);
      const tree = yield* io(keyId(key), () => realpath(containedPath(entryPath(key), "tree")));
      if (options.verify === true && (yield* io(keyId(key), () => treeDigest(tree))) !== record.treeDigest)
        return undefined;
      return { key, pin, root: tree };
    });
    return withLease(
      "use",
      Effect.suspend(() => (keys.has(`${key.kind}/${keyId(key)}`) ? body : locked(body))),
    );
  };
  const publish = Effect.fn("SourceStore.publish")(function* <P extends SourcePin>(input: {
    readonly key: SourceKey;
    readonly pin: P;
    readonly stage: string;
    readonly repair: boolean;
    readonly source: string;
  }): Effect.fn.Return<SourceSnapshot<P>, SourceAcquisitionError> {
    const { key, pin, stage } = input;
    if (!validKey(key))
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: "Acquisition did not return a full content identity.",
          source: displaySource(input.source),
          kind: "fetch-failed",
          remediation: "Use a source transport returning the requested full commit or digest.",
        }),
      );
    const digest = yield* io(input.source, () => treeDigest(containedPath(stage, "tree")));
    const record: EntryRecord = {
      version: 1,
      format: 1,
      kind: key.kind,
      id: keyId(key),
      treeDigest: digest,
      provenance: { source: displaySource(input.source) },
    };
    yield* io(input.source, () =>
      writeFile(containedPath(stage, "entry.json"), JSON.stringify(record), { mode: 0o600 }),
    );
    return yield* withLease(
      "use",
      locked(
        Effect.gen(function* () {
          const existing = yield* readEntry(key);
          const target = entryPath(key);
          const replace =
            existing !== undefined &&
            input.repair &&
            (yield* io(input.source, () => treeDigest(containedPath(target, "tree")))) !== digest;
          if (existing === undefined || replace) {
            yield* io(input.source, async () => {
              await mkdir(containedPath(root, key.kind), { recursive: true });
              await realContainedPath(root, containedPath(root, key.kind));
              let aside: string | undefined;
              try {
                await lstat(target);
                aside = containedPath(root, `.replaced-${process.pid}-${crypto.randomUUID()}`);
                await rename(target, aside);
              } catch (cause) {
                if (!isErrnoCode(cause, "ENOENT")) throw cause;
              }
              try {
                await rename(stage, target);
              } catch (cause) {
                if (aside !== undefined) await rename(aside, target);
                throw cause;
              }
              // Replaced published trees belong to meta:sources:gc, including
              // leftovers after a crash. Publication only changes namespace membership.
            });
          }
          yield* register(key);
          return { key, pin, root: yield* io(input.source, () => realpath(containedPath(target, "tree"))) };
        }),
      ),
    );
  });
  return {
    root,
    locked,
    sessionLocked: <A, E>(body: Effect.Effect<A, E>) => withLease("use", locked(body)),
    open,
    publish,
    stage,
    // Empty creation and unlink expose no entries. The session mutex also
    // excludes warm opens and late publication while release is in progress.
    initialize: withLease(
      "initialize",
      io("lease", async () => {
        await mkdir(root, { recursive: true });
        await mkdir(containedPath(root, ".leases"), { recursive: true, mode: 0o700 });
        await realContainedPath(root, containedPath(root, ".leases"));
      }).pipe(Effect.andThen(writeLease())),
    ),
    release: withLease(
      "release",
      io("lease", () => rm(leasePath, { force: true })),
    ),
  };
};
export type Storage = ReturnType<typeof makeStorage>;
