import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomicScoped } from "@lando/state-store/atomic";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";

export const readDetachedWorkerRecord = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      const value: unknown = await file.json();
      return Schema.decodeUnknownSync(schema)(value);
    },
    catch: (cause) => cause,
  });

export const writeDetachedWorkerRecord = <A, I>(
  options: {
    readonly path: string;
    readonly schema: Schema.Codec<A, I>;
    readonly privateFileAccess: PrivateFileAccess;
    readonly directoryMode?: number;
  },
  record: A,
) =>
  Effect.tryPromise({
    try: () => mkdir(dirname(options.path), { recursive: true, mode: options.directoryMode ?? 0o700 }),
    catch: (cause) => cause,
  }).pipe(
    Effect.andThen(
      Effect.try(() => `${JSON.stringify(Schema.encodeSync(options.schema)(record), null, 2)}\n`),
    ),
    Effect.flatMap((body) =>
      writeFileAtomicScoped(options.path, body, {
        mode: 0o600,
        privateFileAccess: options.privateFileAccess.enforce,
      }),
    ),
  );

export const withDetachedWorkerLock = <A, E>(
  options: {
    readonly path: string;
    readonly label: string;
    readonly privateFileAccess: PrivateFileAccess;
  },
  body: Effect.Effect<A, E>,
) => withAdvisoryLockUsing(options.privateFileAccess)(options.path, options.label, body);

/**
 * Whether a worker record may be trusted: a regular file owned by this user with no group or other
 * access. `PrivateFileAccess.verify` checks Windows ACLs; on POSIX it is a no-op, so check mode and owner.
 */
export const isOwnerOnlyRecordFile = (
  path: string,
  privateFileAccess: PrivateFileAccess,
): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    await privateFileAccess.verify(path);
    if (process.platform === "win32") return true;
    const metadata = await lstat(path);
    return metadata.isFile() && (metadata.mode & 0o077) === 0 && metadata.uid === process.getuid?.();
  }).pipe(Effect.catch(() => Effect.succeed(false)));
