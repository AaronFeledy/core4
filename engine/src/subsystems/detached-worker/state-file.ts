import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomicScoped } from "@lando/state-store/atomic";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { type WorkerClaim, changeWorkerClaim } from "./claim.ts";

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
  claim: WorkerClaim,
  options: {
    readonly schema: Schema.Codec<A, I>;
    readonly privateFileAccess: PrivateFileAccess;
    readonly directoryMode?: number;
  },
  record: A,
) =>
  changeWorkerClaim(
    claim,
    "publish",
    Effect.tryPromise({
      try: () => mkdir(dirname(claim.path), { recursive: true, mode: options.directoryMode ?? 0o700 }),
      catch: (cause) => cause,
    }).pipe(
      Effect.andThen(
        Effect.try(() => `${JSON.stringify(Schema.encodeSync(options.schema)(record), null, 2)}\n`),
      ),
      Effect.flatMap((body) =>
        writeFileAtomicScoped(claim.path, body, {
          mode: 0o600,
          privateFileAccess: options.privateFileAccess.enforce,
        }),
      ),
    ),
  );

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
