/**
 * The single authority for "which executable may Lando 4 replace or remove".
 *
 * Ownership itself stays the four-condition predicate in `./record.ts`. This
 * module adds the one extra operation policy destructive commands need — the
 * target must carry Lando 4's own executable name — and it resolves the target
 * from the install record instead of from the running process, so a foreign
 * `lando` can never be renamed, replaced, or deleted.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import { writeFileAtomicViaRename } from "../cache/atomic";
import { type InstallRecord, decodeInstallRecord, installRecordOwnsDestination } from "./record";

export const LANDO4_POSIX_EXECUTABLE_NAME = "lando4";
export const LANDO4_WINDOWS_EXECUTABLE_NAME = "lando4.exe";

// Windows paths must split on both separators even when this runs on a POSIX
// host, so a win32 verdict does not depend on which machine evaluates it.
const executableName = (path: string, platform: string): string =>
  platform === "win32" ? (path.split(/[\\/]/u).pop() ?? path) : basename(path);

/** Windows compares case-insensitively; every other host requires the exact name. */
export const isLando4ExecutableName = (path: string, platform: string): boolean =>
  platform === "win32"
    ? executableName(path, platform).toLowerCase() === LANDO4_WINDOWS_EXECUTABLE_NAME
    : executableName(path, platform) === LANDO4_POSIX_EXECUTABLE_NAME;

export const INSTALL_OWNERSHIP_REMEDIATION =
  "Lando 4 replaces and removes only the executable recorded in its own install record. Rerun the Lando 4 installer to repair the record, or update through the package manager that installed this copy. Lando never adopts an executable it did not install.";

export class InstallOwnershipError extends Schema.TaggedError<InstallOwnershipError>()(
  "InstallOwnershipError",
  {
    reason: Schema.Literal(
      "no-record",
      "record-unreadable",
      "record-invalid",
      "foreign-basename",
      "path-mismatch",
      "not-regular-file",
      "digest-mismatch",
      "size-mismatch",
      "destination-unreadable",
    ),
    recordFile: Schema.String,
    destination: Schema.optional(Schema.String),
    message: Schema.String,
    remediation: Schema.String,
  },
) {}

const refuse = (
  reason: InstallOwnershipError["reason"],
  recordFile: string,
  detail: string,
  destination?: string,
): InstallOwnershipError =>
  new InstallOwnershipError({
    reason,
    recordFile,
    ...(destination === undefined ? {} : { destination }),
    message: detail,
    remediation: INSTALL_OWNERSHIP_REMEDIATION,
  });

export interface OwnedExecutable {
  readonly path: string;
  readonly record: InstallRecord;
  readonly sha256: string;
  readonly size: number;
}

export interface ResolveOwnedExecutableOptions {
  readonly recordFile: string;
  readonly platform: string;
  /** When supplied, the caller's intended target must be the recorded path. */
  readonly destination?: string;
}

const readRecord = (recordFile: string): Either.Either<InstallRecord, InstallOwnershipError> => {
  const recordStat = lstatSync(recordFile, { throwIfNoEntry: false });
  if (recordStat === undefined)
    return Either.left(refuse("no-record", recordFile, "Lando 4 has no install record."));
  if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.isDirectory())
    return Either.left(refuse("record-invalid", recordFile, "Install record must be a regular file."));
  let json: string;
  try {
    json = readFileSync(recordFile, "utf8");
  } catch {
    return Either.left(refuse("record-unreadable", recordFile, "Cannot read the install record."));
  }
  const decoded = Effect.runSync(Effect.either(decodeInstallRecord(json, recordFile)));
  return Either.isLeft(decoded)
    ? Either.left(refuse("record-invalid", recordFile, decoded.left.detail))
    : Either.right(decoded.right);
};

const hashFile = (path: string): Either.Either<string, "unreadable"> => {
  try {
    return Either.right(createHash("sha256").update(readFileSync(path)).digest("hex"));
  } catch {
    return Either.left("unreadable");
  }
};

const inspect = (options: ResolveOwnedExecutableOptions): Either.Either<OwnedExecutable, InstallOwnershipError> => {
  const { recordFile, platform } = options;
  const record = readRecord(recordFile);
  if (Either.isLeft(record)) return record;
  const destination = record.right.data.executable.path;
  if (options.destination !== undefined && resolve(options.destination) !== resolve(destination)) {
    return Either.left(
      refuse(
        "path-mismatch",
        recordFile,
        `${options.destination} is not the executable recorded by Lando 4.`,
        options.destination,
      ),
    );
  }
  if (!isLando4ExecutableName(destination, platform)) {
    return Either.left(
      refuse(
        "foreign-basename",
        recordFile,
        `${destination} does not carry Lando 4's executable name.`,
        destination,
      ),
    );
  }
  const stat = lstatSync(destination, { throwIfNoEntry: false });
  if (stat === undefined)
    return Either.left(
      refuse("destination-unreadable", recordFile, `${destination} no longer exists.`, destination),
    );
  const digest = stat.isFile() && !stat.isSymbolicLink() ? hashFile(destination) : Either.right("");
  if (Either.isLeft(digest))
    return Either.left(
      refuse("destination-unreadable", recordFile, `Cannot read ${destination}.`, destination),
    );
  const ownership = installRecordOwnsDestination(
    record.right,
    destination,
    {
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    },
    digest.right,
  );
  if (!ownership.owned) {
    return Either.left(
      refuse(
        ownership.reason === "no-record" ? "record-invalid" : ownership.reason,
        recordFile,
        `${destination} does not match Lando 4's install record (${ownership.reason}).`,
        destination,
      ),
    );
  }
  return Either.right({
    path: destination,
    record: record.right,
    sha256: digest.right,
    size: stat.size,
  });
};

/**
 * Synchronous verdict for callers that cannot suspend (the uninstall planner is
 * a plain async function). `resolveOwnedExecutable` is the same rule as an Effect.
 */
export const inspectOwnedExecutable = inspect;

export const resolveOwnedExecutable = (
  options: ResolveOwnedExecutableOptions,
): Effect.Effect<OwnedExecutable, InstallOwnershipError> =>
  Effect.suspend(() => {
    const verdict = inspect(options);
    return Either.isLeft(verdict) ? Effect.fail(verdict.left) : Effect.succeed(verdict.right);
  });

export interface RefreshInstallRecordOptions {
  readonly recordFile: string;
  readonly record: InstallRecord;
  readonly sha256: string;
  readonly size: number;
  readonly releaseVersion: string;
}

/**
 * Re-point the record at the bytes now on disk. Without this an update leaves
 * the record describing the binary it just replaced, and the next update or
 * uninstall refuses to touch the copy Lando itself installed.
 */
export const refreshInstallRecord = (
  options: RefreshInstallRecordOptions,
): Effect.Effect<void, InstallOwnershipError> => {
  const next: InstallRecord = {
    version: 1,
    data: {
      ...options.record.data,
      executable: {
        ...options.record.data.executable,
        sha256: options.sha256,
        size: options.size,
        releaseVersion: options.releaseVersion,
      },
    },
  };
  return Effect.tryPromise({
    try: () =>
      writeFileAtomicViaRename(options.recordFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
    catch: () =>
      refuse(
        "record-unreadable",
        options.recordFile,
        "Cannot rewrite the install record for the installed executable.",
        options.record.data.executable.path,
      ),
  });
};
