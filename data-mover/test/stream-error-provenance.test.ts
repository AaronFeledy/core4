import { expect, test } from "bun:test";
import { join } from "node:path";
import { ArchiveFormatError, DataTransferError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Stream } from "effect";
import { decodeArchiveStream, encodeArchiveStream } from "../src/archive-stream.ts";
import { withFileTransport } from "./file-transport-fixture.ts";

for (const format of ["tar", "tar.gz", "tar.zst"] as const) {
  for (const direction of ["encode", "decode"] as const) {
    test(`${format} ${direction} preserves source failures, cleanup defects and cancellation`, async () => {
      const sourceError = Object.assign(new Error("source failed"), { code: "ENOSPC" });
      const cleanupError = new Error("cleanup failed");
      const sourceCause = Cause.combine(
        Cause.combine(Cause.fail(sourceError), Cause.die(cleanupError)),
        Cause.interrupt(),
      );
      const body = Stream.failCause(sourceCause);
      const result = await Effect.runPromiseExit(
        (direction === "encode"
          ? encodeArchiveStream({ body, format, path: "/archive", sizeBytes: 1 })
          : decodeArchiveStream({ body, format, path: "/archive", maxPayloadBytes: 1024 })
        ).pipe(Stream.runDrain, Effect.scoped),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (!Exit.isFailure(result)) throw new Error("Expected source failure");
      expect(result.cause.reasons).toEqual(sourceCause.reasons);
    });
  }
}

test("malformed compressed bytes remain codec errors", async () => {
  const error = await Effect.runPromise(
    decodeArchiveStream({
      body: Stream.make(new TextEncoder().encode("invalid gzip")),
      format: "tar.gz",
      path: "/archive",
      maxPayloadBytes: 1024,
    }).pipe(Stream.runDrain, Effect.scoped, Effect.flip),
  );
  expect(error).toBeInstanceOf(ArchiveFormatError);
});

for (const archive of [false, true]) {
  test(`DataMover preserves provider error identity through ${archive ? "staged archive" : "file"} transfer`, async () => {
    await withFileTransport(async ({ root, mover }) => {
      const providerError = Object.assign(
        new ProviderUnavailableError({
          providerId: "test",
          operation: "copyFromService",
          message: "provider offline",
          remediation: "Start the selected provider.",
        }),
        { code: "ENOSPC" },
      );
      const cleanup = new Error("provider cleanup failed");
      const body = Stream.fromEffect(
        Effect.acquireRelease(Effect.void, () => Effect.die(cleanup)).pipe(
          Effect.andThen(Effect.fail(providerError)),
        ),
      );
      const result = await Effect.runPromiseExit(
        mover({
          ...TestRuntimeProvider,
          capabilities: { ...TestRuntimeProvider.capabilities, serviceFileCopy: "native" },
          copyFromService: () => body,
        })
          .transfer({
            from: {
              _tag: "servicePath",
              app: AppId.make("app"),
              service: ServiceName.make("db"),
              path: PortablePath.make("/dump"),
            },
            to: archive
              ? { _tag: "hostArchive", path: AbsolutePath.make(join(root, "target")), format: "tar.gz" }
              : { _tag: "hostPath", path: AbsolutePath.make(join(root, "target")) },
          })
          .pipe(Effect.scoped),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (!Exit.isFailure(result)) throw new Error("Expected provider failure");
      const failures = result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      expect(failures).toHaveLength(1);
      const failure = failures[0];
      expect(failure).toBeInstanceOf(DataTransferError);
      if (!(failure instanceof DataTransferError)) throw new Error("Expected provider transfer error");
      expect(failure.operation).toBe("copyFromService");
      expect(failure.remediation).toBe("Start the selected provider.");
      expect(failure.cause).toBe(providerError);
      expect(result.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        cleanup,
      ]);
    });
  });
}
