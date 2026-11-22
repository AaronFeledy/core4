import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import { type Stats, constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { databaseAdminSeedPath } from "@lando/paths";
import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import { Effect, Redacted } from "effect";
import { writeFileAtomic } from "./atomic.ts";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "./lock.ts";
import {
  type PrivateFileAccess,
  PrivateFileAccessError,
  PrivateFileAccessService,
} from "./private-file-access.ts";

const windows = process.platform === "win32";
const owned = (stat: Stats) => stat.uid === process.geteuid?.();

// The data root is often group-writable under user-private groups (umask 0002); the 0700 seed
// directory is the privacy boundary, so only a root other users can all write to is refused.
const prepareRoot = async (root: string) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await verifyRoot(root);
};

const verifyRoot = async (root: string) => {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || (!windows && (!owned(rootStat) || (rootStat.mode & 0o002) !== 0))) {
    throw new PrivateFileAccessError(root);
  }
};

const prepareDirectory = async (directory: string, access: PrivateFileAccess) => {
  try {
    await mkdir(directory, { mode: 0o700 });
    if (windows) await access.enforce(directory);
    else await chmod(directory, 0o700);
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) throw error;
  }
  await verifyDirectory(directory, access);
};

const verifyDirectory = async (directory: string, access: PrivateFileAccess) => {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (!windows && (!owned(stat) || (stat.mode & 0o777) !== 0o700))) {
    throw new PrivateFileAccessError(directory);
  }
  if (windows) await access.verify(directory);
};

const readSeed = async (file: string, access: PrivateFileAccess) => {
  const named = await lstat(file).catch((error: unknown) => {
    if (!isErrnoCode(error, "ENOENT")) throw error;
    return undefined;
  });
  if (named === undefined) return undefined;
  const privateRegularFile = (stat: Stats) =>
    stat.isFile() && (windows || (owned(stat) && (stat.mode & 0o777) === 0o600));
  if (!privateRegularFile(named)) throw new PrivateFileAccessError(file);
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (windows) await access.verify(file);
    const observed = await handle.stat();
    const current = await lstat(file);
    if (
      observed.size !== 44 ||
      !privateRegularFile(observed) ||
      !privateRegularFile(current) ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino
    ) {
      throw new PrivateFileAccessError(file);
    }
    const encoded = Buffer.alloc(45);
    const { bytesRead } = await handle.read(encoded, 0, encoded.length, 0);
    const seed = Buffer.from(encoded.subarray(0, 43).toString("utf8"), "base64url");
    if (
      bytesRead !== 44 ||
      seed.length !== 32 ||
      !encoded.subarray(0, bytesRead).equals(Buffer.from(`${seed.toString("base64url")}\n`))
    ) {
      throw new PrivateFileAccessError(file);
    }
    return seed;
  } finally {
    await handle.close();
  }
};

export const deriveDatabaseAdminPassword = Effect.fnUntraced(function* <R>(input: {
  readonly userDataRoot: string;
  readonly family: "mysql" | "mariadb" | "mongodb" | "mssql";
  readonly generation: string;
  readonly mode?: "read";
  readonly register: (values: readonly string[]) => Effect.Effect<void, never, R>;
}) {
  const access = yield* PrivateFileAccessService;
  const file = databaseAdminSeedPath(input.userDataRoot);
  const directory = dirname(file);
  const seedError = () =>
    new StateStoreError({
      reason: "io",
      operation: "database admin seed",
      path: file,
      remediation:
        "Check ownership and permissions or restore the original private database admin seed. Do not replace it with a new seed.",
    });
  const seed = yield* input.mode === "read"
    ? Effect.tryPromise({
        try: async () => {
          await verifyRoot(input.userDataRoot);
          await verifyDirectory(directory, access);
          const stored = await readSeed(file, access);
          if (stored === undefined) throw new PrivateFileAccessError(file);
          return stored;
        },
        catch: seedError,
      })
    : Effect.tryPromise({ try: () => prepareRoot(input.userDataRoot), catch: seedError }).pipe(
        Effect.andThen(
          Effect.scoped(
            acquireAdvisoryLockAt(`${directory}${ADVISORY_LOCK_SUFFIX}`, "database admin seed", {
              privateFileAccess: access,
            }).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: async () => {
                    await prepareDirectory(directory, access);
                    return readSeed(file, access);
                  },
                  catch: seedError,
                }),
              ),
              Effect.flatMap((stored) =>
                stored === undefined
                  ? Effect.uninterruptible(
                      Effect.tryPromise({
                        try: async () => {
                          const fresh = randomBytes(32);
                          await writeFileAtomic(file, `${fresh.toString("base64url")}\n`, {
                            mode: 0o600,
                            privateFileAccess: access.enforce,
                            // Never overwrite seed material, including a file created by a different writer.
                            renameFile: async (source, target) => {
                              await link(source, target);
                              await unlink(source);
                            },
                          });
                          return fresh;
                        },
                        catch: seedError,
                      }),
                    )
                  : Effect.succeed(stored),
              ),
            ),
          ),
        ),
      );

  const password = `L1a!${createHmac("sha256", seed)
    .update(JSON.stringify(["lando-db-admin/v1", input.family, input.generation]))
    .digest("base64url")}`;
  yield* input.register([
    seed.toString("base64url"),
    seed.toString("base64"),
    seed.toString("hex"),
    password,
  ]);
  return Redacted.make(password);
});
