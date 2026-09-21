import { resolve } from "node:path";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Option, Schema, Stream } from "effect";

const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));

export const InstallRecord = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    executable: Schema.Struct({
      path: Schema.String,
      sha256: Sha256,
      size: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      channel: Schema.String,
      platform: Schema.String,
      releaseVersion: Schema.optional(Schema.String),
    }),
    shellProfiles: Schema.Array(Schema.Struct({ path: Schema.String, blockSha256: Sha256 })),
  }),
});
export type InstallRecord = typeof InstallRecord.Type;

export class InstallRecordError extends Schema.TaggedError<InstallRecordError>()("InstallRecordError", {
  reason: Schema.Literal("invalid-json", "schema", "unsupported-version", "not-regular-file", "io"),
  file: Schema.String,
  detail: Schema.String,
  remediation: Schema.String,
}) {}

const recordError = (
  reason: InstallRecordError["reason"],
  file: string,
  detail: string,
): InstallRecordError =>
  new InstallRecordError({
    reason,
    file,
    detail,
    remediation:
      "Check the install record and executable permissions; rerun the Lando 4 installer to repair the record. Do not adopt an unrecognized executable.",
  });

export const decodeInstallRecord = (
  json: string,
  file: string,
): Effect.Effect<InstallRecord, InstallRecordError> =>
  Effect.gen(function* () {
    const value: unknown = yield* Schema.decodeUnknown(Schema.parseJson())(json).pipe(
      Effect.mapError(() => recordError("invalid-json", file, "Install record is not valid JSON.")),
    );
    if (typeof value === "object" && value !== null && "version" in value && value.version !== 1) {
      return yield* recordError("unsupported-version", file, "Only install record version 1 is supported.");
    }
    return yield* Schema.decodeUnknown(InstallRecord)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        recordError("schema", file, "Install record does not match the version 1 schema."),
      ),
    );
  });

export type InstallDestinationStat = {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
};

export type InstallRecordOwnership =
  | { readonly owned: true }
  | {
      readonly owned: false;
      readonly reason:
        | "path-mismatch"
        | "not-regular-file"
        | "digest-mismatch"
        | "size-mismatch"
        | "no-record";
    };

// Four arguments preserve the requested pure comparison API: record, path, metadata, and content proof.
export const installRecordOwnsDestination = (
  record: InstallRecord,
  destination: string,
  stat: InstallDestinationStat,
  digest: string,
): InstallRecordOwnership => {
  const executable = record.data.executable;
  if (resolve(executable.path) !== resolve(destination)) return { owned: false, reason: "path-mismatch" };
  if (!stat.isFile || stat.isSymbolicLink || stat.isDirectory)
    return { owned: false, reason: "not-regular-file" };
  if (digest !== executable.sha256) return { owned: false, reason: "digest-mismatch" };
  if (stat.size !== executable.size) return { owned: false, reason: "size-mismatch" };
  return { owned: true };
};

export const readInstallRecord = (
  file: string,
): Effect.Effect<Option.Option<InstallRecord>, InstallRecordError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const stat = yield* fs.lstat(file).pipe(
      Effect.map(Option.some),
      Effect.catchTag("FileNotFoundError", () => Effect.succeed(Option.none())),
      Effect.mapError(() => recordError("io", file, "Cannot inspect install record.")),
    );
    if (Option.isNone(stat)) return Option.none();
    if (!stat.value.isFile || stat.value.isSymbolicLink || stat.value.isDirectory) {
      return yield* recordError(
        "not-regular-file",
        file,
        "Install record must be a regular file, not a symlink or directory.",
      );
    }
    const json = yield* fs
      .readText(file)
      .pipe(Effect.mapError(() => recordError("io", file, "Cannot read install record.")));
    return Option.some(yield* decodeInstallRecord(json, file));
  });

export const verifyInstallRecordOwnership = (
  file: string,
  destination: string,
): Effect.Effect<InstallRecordOwnership, InstallRecordError, FileSystem> =>
  Effect.gen(function* () {
    const record = yield* readInstallRecord(file);
    if (Option.isNone(record)) return { owned: false, reason: "no-record" };
    if (resolve(record.value.data.executable.path) !== resolve(destination)) {
      return { owned: false, reason: "path-mismatch" };
    }
    const fs = yield* FileSystem;
    const stat = yield* fs
      .lstat(destination)
      .pipe(Effect.mapError(() => recordError("io", destination, "Cannot inspect installed executable.")));
    if (!stat.isFile || stat.isSymbolicLink || stat.isDirectory) {
      return { owned: false, reason: "not-regular-file" };
    }
    const hash = yield* fs.read(destination).pipe(
      Stream.runFold(new Bun.CryptoHasher("sha256"), (hasher, chunk) => hasher.update(chunk)),
      Effect.mapError(() => recordError("io", destination, "Cannot read installed executable.")),
    );
    return installRecordOwnsDestination(
      record.value,
      destination,
      { ...stat, isSymbolicLink: stat.isSymbolicLink ?? false },
      hash.digest("hex"),
    );
  });
