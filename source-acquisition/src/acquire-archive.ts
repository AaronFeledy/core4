import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import { extractArchive } from "./archive.ts";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { acquireTransport } from "./transport.ts";
import { containedPath } from "./tree.ts";
import type { ArchiveAcquisitionOptions, SourceStoreOptions } from "./types.ts";

export const archiveAcquisition = (options: SourceStoreOptions, storage: Storage) => {
  const openArchive = (sha256: string) =>
    storage.open({ kind: "archive", sha256 }, { kind: "archive", sha256, url: "" });
  const publishBytes = (input: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly source: string;
    readonly repair: boolean;
  }) =>
    storage.stage((stage) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => extractArchive(input.bytes, containedPath(stage, "tree")),
          catch: (cause) => acquisitionError("extract-failed", input.source, cause),
        }).pipe(Effect.uninterruptible);
        return yield* storage.publish({
          key: { kind: "archive", sha256: input.sha256 },
          pin: { kind: "archive", sha256: input.sha256, url: input.source },
          stage,
          source: input.source,
          repair: input.repair,
        });
      }),
    );
  const acquireArchive = Effect.fn("SourceSession.acquireArchive")(function* (
    locator: { readonly url: string; readonly sha256?: string },
    acquisition: ArchiveAcquisitionOptions = {},
  ) {
    const expected = locator.sha256?.trim().toLowerCase();
    if (expected !== undefined && !/^[a-f\d]{64}$/u.test(expected))
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `--checksum must be a 64-character hex SHA-256 digest: ${locator.sha256}`,
          source: displaySource(locator.url),
          kind: "checksum-mismatch",
          remediation: "Pass --checksum=<sha256> as 64 lowercase hex characters.",
        }),
      );
    if (expected !== undefined && !acquisition.repair) {
      const snapshot = yield* storage.open(
        { kind: "archive", sha256: expected },
        { kind: "archive", sha256: expected, url: locator.url },
      );
      if (snapshot !== undefined) return snapshot;
    }
    const transport = options.transports.archive;
    if (transport === undefined)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: "Archive transport is unavailable.",
          source: displaySource(locator.url),
          kind: "fetch-failed",
          remediation: "Provide an archive transport and retry.",
        }),
      );
    const bytes = yield* acquireTransport(locator.url, (signal) => transport.fetch(locator.url, { signal }));
    const sha256 = sha256Hex(bytes);
    if (expected !== undefined && sha256 !== expected)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `Tarball recipe SHA-256 mismatch for ${displaySource(locator.url)}: expected ${expected}, got ${sha256}.`,
          source: displaySource(locator.url),
          kind: "checksum-mismatch",
          remediation:
            "Verify the --checksum value or re-download the tarball; the archive was not extracted.",
        }),
      );
    if (expected === undefined && acquisition.onUnverified !== undefined)
      yield* Effect.tryPromise({
        try: async () => acquisition.onUnverified?.(sha256),
        catch: (cause) => acquisitionError("checksum-mismatch", locator.url, cause),
      });
    if (!acquisition.repair) {
      const snapshot = yield* storage.open(
        { kind: "archive", sha256 },
        { kind: "archive", sha256, url: locator.url },
      );
      if (snapshot !== undefined) return snapshot;
    }
    return yield* publishBytes({ bytes, sha256, source: locator.url, repair: acquisition.repair === true });
  });
  return { openArchive, acquireArchive, publishBytes };
};
