import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataTransferError, FileIoError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";

import { withHostDumpCompression, writeDumpTransform } from "../src/compression.ts";

const failureOf = (exit: Exit.Exit<unknown, unknown>): DataTransferError => {
  if (!Exit.isFailure(exit)) throw new Error("expected compression failure");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(DataTransferError);
  if (!(error instanceof DataTransferError)) throw new Error("expected transfer error");
  return error;
};

describe("compressed export filesystem failures", () => {
  let root = "";
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "lando-compression-errors-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "#2021 reports a writable destination when staging is denied without transferring or replacing bytes",
    async () => {
      const destination = join(root, "dump.sql.gz");
      await fs.writeFile(destination, "previous dump");
      await fs.chmod(root, 0o555);
      let transferred = false;
      try {
        const error = failureOf(
          await Effect.runPromiseExit(
            withHostDumpCompression({
              path: destination,
              compression: "gzip",
              transfer: () =>
                Effect.sync(() => {
                  transferred = true;
                  return { accelerated: false };
                }),
            }),
          ),
        );
        expect(error).toMatchObject({ toEndpoint: "hostPath", operation: "stage" });
        expect(error.cause).toMatchObject({
          _tag: "FileIoError",
          path: root,
          operation: "stage",
          reason: "permission-denied",
        });
        expect(error.remediation).toMatch(/permissions/iu);
        expect(error.remediation).not.toMatch(/disk space/iu);
        expect(transferred).toBe(false);
        expect(await fs.readFile(destination, "utf8")).toBe("previous dump");
        expect(await fs.readdir(root)).toEqual(["dump.sql.gz"]);
      } finally {
        await fs.chmod(root, 0o755);
      }
    },
  );

  test("reports an invalid parent path without blaming disk space or transferring", async () => {
    const parent = join(root, "file");
    await fs.writeFile(parent, "keep me");
    let transferred = false;
    const error = failureOf(
      await Effect.runPromiseExit(
        withHostDumpCompression({
          path: join(parent, "dump.sql.zst"),
          compression: "zstd",
          transfer: () =>
            Effect.sync(() => {
              transferred = true;
              return { accelerated: false };
            }),
        }),
      ),
    );
    expect(error.remediation).toMatch(/directory/iu);
    expect(error.remediation).not.toMatch(/disk space/iu);
    expect(error.cause).toMatchObject({
      _tag: "FileIoError",
      path: parent,
      operation: "stage",
      reason: "invalid-path",
    });
    expect(transferred).toBe(false);
    expect(await fs.readFile(parent, "utf8")).toBe("keep me");
  });

  // Real disk exhaustion cannot safely be induced in the shared host filesystem.
  test("normalizes ENOSPC staging failures and forwards safe guidance before transferring", async () => {
    const cause = Object.assign(new Error("HOSTILE_MESSAGE"), {
      code: "ENOSPC",
      stack: "HOSTILE_STACK",
      payload: "HOSTILE_PAYLOAD",
      cause: { message: "HOSTILE_CAUSE" },
    });
    const staging = spyOn(fs, "mkdtemp").mockRejectedValueOnce(cause);
    let transferred = false;
    try {
      const error = failureOf(
        await Effect.runPromiseExit(
          withHostDumpCompression({
            path: join(root, "dump.sql.gz"),
            compression: "gzip",
            transfer: () =>
              Effect.sync(() => {
                transferred = true;
                return { accelerated: false };
              }),
          }),
        ),
      );
      expect(error).toMatchObject({ toEndpoint: "hostPath", operation: "stage" });
      expect(error.cause).toMatchObject({
        _tag: "FileIoError",
        operation: "stage",
        path: root,
        reason: "no-space",
      });
      expect(error.cause).toBeInstanceOf(FileIoError);
      if (!(error.cause instanceof FileIoError)) throw new Error("expected safe cause");
      expect(error.remediation).toBe(error.cause.remediation);
      expect(error.cause.cause).toBeUndefined();
      expect(`${error.stack}\n${error.cause.stack}\n${JSON.stringify(error)}`).not.toMatch(/HOSTILE_/u);
      expect(transferred).toBe(false);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      staging.mockRestore();
    }
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "preserves filesystem cause and writable destination guidance when persisting compression fails",
    async () => {
      const destination = join(root, "dump.sql.gz");
      const source = join(root, "plain.sql");
      await fs.writeFile(destination, "previous dump");
      await fs.writeFile(source, "select 1;");
      await fs.chmod(root, 0o555);
      try {
        const error = failureOf(
          await Effect.runPromiseExit(writeDumpTransform(source, destination, "gzip", "compress")),
        );
        expect(error).toMatchObject({ toEndpoint: "hostPath", operation: "persist" });
        expect(error.cause).toMatchObject({
          _tag: "FileIoError",
          operation: "persist",
          path: destination,
          reason: "permission-denied",
        });
        expect(error.remediation).toMatch(/permissions/iu);
        expect(error.remediation).not.toMatch(/disk space/iu);
        expect(await fs.readFile(destination, "utf8")).toBe("previous dump");
      } finally {
        await fs.chmod(root, 0o755);
      }
      expect((await fs.readdir(root)).sort()).toEqual(["dump.sql.gz", "plain.sql"]);
    },
  );

  test.each(["gzip", "zstd"] as const)(
    "retains a missing %s source cause instead of diagnosing disk space",
    async (compression) => {
      const error = failureOf(
        await Effect.runPromiseExit(
          writeDumpTransform(join(root, "missing.sql"), join(root, "dump.sql.gz"), compression, "compress"),
        ),
      );
      expect(error).toMatchObject({ fromEndpoint: "hostPath", operation: "read" });
      expect(error.cause).toMatchObject({
        _tag: "FileIoError",
        operation: "read",
        path: join(root, "missing.sql"),
        reason: "not-found",
      });
      expect(error.remediation).not.toMatch(/disk space/iu);
      expect(await fs.readdir(root)).toEqual([]);
    },
  );
});
