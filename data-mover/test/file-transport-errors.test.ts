import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DataTransferError, FileIoError } from "@lando/sdk/errors";
import { AbsolutePath, type DataEndpoint } from "@lando/sdk/schema";
import { Effect, Schema, Stream } from "effect";
import { withFileTransport } from "./file-transport-fixture.ts";

const hostSource = (path: string, archive: boolean): DataEndpoint =>
  archive
    ? { _tag: "hostArchive", path: AbsolutePath.make(path), format: "tar" }
    : { _tag: "hostPath", path: AbsolutePath.make(path) };

for (const archive of [false, "tar", "tar.gz", "tar.zst"] as const) {
  for (const missing of [false, true]) {
    test.skipIf(!missing && (process.platform === "win32" || process.getuid?.() === 0))(
      `host ${archive || "file"} read reports safe ${missing ? "missing" : "permission"} source diagnostics`,
      async () => {
        await withFileTransport(async ({ root, mover }) => {
          const path = join(root, "source");
          if (!missing) {
            await fs.writeFile(path, "private source bytes");
            await fs.chmod(path, 0);
          }
          const error = await Effect.runPromise(
            mover()
              .read(
                archive
                  ? { _tag: "hostArchive", path: AbsolutePath.make(path), format: archive }
                  : hostSource(path, false),
              )
              .pipe(Stream.runDrain, Effect.scoped, Effect.flip),
          );
          expect(error).toBeInstanceOf(DataTransferError);
          if (!(error instanceof DataTransferError)) throw new Error("Expected transfer error");
          expect(error.operation).toBe("read-host");
          expect(error.fromEndpoint).toBe(`hostPath:${path}`);
          expect(error.cause).toBeInstanceOf(FileIoError);
          if (!(error.cause instanceof FileIoError)) throw new Error("Expected filesystem cause");
          expect(Schema.encodeSync(FileIoError)(error.cause)).toEqual({
            _tag: "FileIoError",
            operation: "read",
            path,
            reason: missing ? "not-found" : "permission-denied",
            message: expect.stringContaining(`Failed to read file at ${path}:`),
            remediation: missing
              ? "Check that the path and required parent directories exist, or correct the path, then retry."
              : "Check ownership and permissions on the path and its parent directories, or choose a readable source, then retry.",
          });
          expect(error.remediation).toBe(error.cause.remediation);
        });
      },
    );
  }
}

test("host-to-host missing source keeps source role through directory inspection", async () => {
  await withFileTransport(async ({ root, mover }) => {
    const source = join(root, "missing");
    const error = await Effect.runPromise(
      mover()
        .transfer({
          from: hostSource(source, false),
          to: hostSource(join(root, "target"), false),
        })
        .pipe(Effect.scoped, Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "DataTransferError",
      operation: "stat-host",
      cause: { _tag: "FileIoError", operation: "read", reason: "not-found", path: source },
    });
  });
});

for (const archive of [false, true]) {
  for (const [code, reason, remediation] of [
    [
      "ENOSPC",
      "no-space",
      "Free space or inodes on the host filesystem, or choose another filesystem, then retry.",
    ],
    [
      "EDQUOT",
      "quota-exceeded",
      "Free storage within your host quota or request a quota increase, then retry.",
    ],
    [
      "EACCES",
      "permission-denied",
      "Check ownership and permissions on the path and its parent directories, or choose a writable destination location, then retry.",
    ],
  ] as const) {
    test(`byte-file ${archive ? "gzip archive" : "plain"} persist reports safe ${code} diagnostics`, async () => {
      await withFileTransport(async ({ root, mover }) => {
        const source = join(root, "source");
        const target = join(root, "target");
        await fs.writeFile(source, "sensitive dump bytes");
        await fs.writeFile(target, "original destination");
        const native = Object.assign(new Error("sensitive dump bytes"), {
          code,
          secret: "private custom field",
          cause: { password: "nested secret" },
        });
        const open = fs.open;
        // Real disk exhaustion cannot safely be induced in the shared host filesystem.
        const opened = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await open(...args);
          if (String(args[0]).startsWith(`${target}.tmp-`)) {
            spyOn(handle, "write").mockImplementation(async () => {
              throw native;
            });
          }
          return handle;
        });
        try {
          const to: DataEndpoint = archive
            ? { _tag: "hostArchive", path: AbsolutePath.make(target), format: "tar.gz" }
            : hostSource(target, false);
          const error = await Effect.runPromise(
            mover()
              .transfer({ from: hostSource(source, false), to })
              .pipe(Effect.scoped, Effect.flip),
          );
          expect(error).toBeInstanceOf(DataTransferError);
          if (!(error instanceof DataTransferError)) throw new Error("Expected transfer error");
          expect(error).toMatchObject({
            operation: "persist",
            fromEndpoint: `hostPath:${source}`,
            toEndpoint: archive ? `hostArchive:tar.gz:${target}` : `hostPath:${target}`,
            remediation,
          });
          expect(error.cause).toBeInstanceOf(FileIoError);
          if (!(error.cause instanceof FileIoError)) throw new Error("Expected filesystem cause");
          expect(Schema.encodeSync(FileIoError)(error.cause)).toEqual({
            _tag: "FileIoError",
            operation: "persist",
            path: target,
            reason,
            message: expect.stringContaining(`Failed to persist file at ${target}:`),
            remediation,
          });
          const encoded = JSON.stringify(Schema.encodeSync(DataTransferError)(error));
          for (const secret of [
            "sensitive dump bytes",
            "private custom field",
            "nested secret",
            `${target}.tmp-`,
          ]) {
            expect(encoded).not.toContain(secret);
          }
          expect(await fs.readFile(target, "utf8")).toBe("original destination");
        } finally {
          opened.mockRestore();
        }
      });
    });
  }
}
