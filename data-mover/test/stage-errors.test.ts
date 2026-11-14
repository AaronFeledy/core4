import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DataTransferError, FileIoError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { VerifiedStreamError } from "@lando/sdk/verified-stream";
import { Effect, Schema, Stream } from "effect";
import { stageVerifiedStream } from "../src/staged-stream.ts";
import { withFileTransport } from "./file-transport-fixture.ts";
import { privateFileAccess } from "./private-file-access.ts";

for (const operation of ["mkdir", "chmod"] as const) {
  test(`DataMover staging ${operation} exhaustion forwards safe stage diagnostics`, async () => {
    await withFileTransport(async ({ root, paths, mover }) => {
      const source = join(root, "source");
      await fs.writeFile(source, "private payload");
      const native = Object.assign(new Error("private payload"), { code: "ENOSPC", cause: "secret" });
      const mkdir = fs.mkdir;
      const chmod = fs.chmod;
      const seam =
        operation === "mkdir"
          ? spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
              if (path === paths.transferStagingDir) throw native;
              await mkdir(path, options);
              return undefined;
            })
          : spyOn(fs, "chmod").mockImplementation(async (path, mode) => {
              if (path === paths.transferStagingDir) throw native;
              return chmod(path, mode);
            });
      try {
        const error = await Effect.runPromise(
          mover()
            .transfer({
              from: { _tag: "hostPath", path: AbsolutePath.make(source) },
              to: { _tag: "hostArchive", path: AbsolutePath.make(join(root, "out.tar")), format: "tar" },
            })
            .pipe(Effect.scoped, Effect.flip),
        );
        expect(error).toBeInstanceOf(DataTransferError);
        if (!(error instanceof DataTransferError)) throw new Error("Expected transfer error");
        expect(error.operation).toBe("stage");
        expect(error.cause).toBeInstanceOf(FileIoError);
        if (!(error.cause instanceof FileIoError)) throw new Error("Expected filesystem cause");
        expect(Schema.encodeSync(FileIoError)(error.cause)).toEqual({
          _tag: "FileIoError",
          operation: "stage",
          reason: "no-space",
          path: paths.transferStagingDir,
          message: `Failed to stage file at ${paths.transferStagingDir}: The filesystem has no free space.`,
          remediation:
            "Free space or inodes on the host filesystem, or choose another filesystem, then retry.",
        });
        expect(error.remediation).toBe(error.cause.remediation);
      } finally {
        seam.mockRestore();
      }
    });
  });
}

for (const location of ["directory", "file"] as const) {
  test(`DataMover keeps callback-owned ${location} failure identity even with an errno code`, async () => {
    await withFileTransport(async ({ root, paths, mover }) => {
      const source = join(root, "source");
      await fs.writeFile(source, "payload");
      const callbackError = Object.assign(new Error("ACL policy rejected"), { code: "ENOSPC" });
      const access = {
        enforce: async (path: string) => {
          if ((path === paths.transferStagingDir) === (location === "directory")) throw callbackError;
        },
        verify: async () => {},
      };
      const error = await Effect.runPromise(
        mover(TestRuntimeProvider, access)
          .transfer({
            from: { _tag: "hostPath", path: AbsolutePath.make(source) },
            to: { _tag: "hostArchive", path: AbsolutePath.make(join(root, "out.tar")), format: "tar" },
          })
          .pipe(Effect.scoped, Effect.flip),
      );
      expect(error).toBeInstanceOf(DataTransferError);
      if (!(error instanceof DataTransferError)) throw new Error("Expected transfer error");
      if (location === "directory") expect(error.cause).toBe(callbackError);
      else {
        expect(error.cause).toBeInstanceOf(VerifiedStreamError);
        if (!(error.cause instanceof VerifiedStreamError)) throw new Error("Expected callback wrapper");
        expect(error.cause.cause).toBe(callbackError);
      }
    });
  });
}

test("staging size mismatch remains verification failure without filesystem diagnostics", async () => {
  await withFileTransport(async ({ paths }) => {
    const error = await Effect.runPromise(
      stageVerifiedStream({
        body: Stream.make(new Uint8Array([1, 2, 3])),
        transferStagingDir: paths.transferStagingDir,
        prefix: "size",
        expectedSizeBytes: 4,
        privateFileAccess,
      }).pipe(Effect.scoped, Effect.flip),
    );
    expect(error).toBeInstanceOf(VerifiedStreamError);
    expect(error).toMatchObject({ reason: "size", expectedSizeBytes: 4, actualSizeBytes: 3 });
  });
});
