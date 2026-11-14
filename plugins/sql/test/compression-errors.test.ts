import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlDumpCompressionError, errnoCode } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";

import { withHostDumpCompression, writeDumpTransform } from "../src/compression.ts";

const failureOf = (exit: Exit.Exit<unknown, unknown>): SqlDumpCompressionError => {
  if (!Exit.isFailure(exit)) throw new Error("expected compression failure");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlDumpCompressionError);
  if (!(error instanceof SqlDumpCompressionError)) throw new Error("expected compression error");
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
        expect(error).toMatchObject({ path: root, operation: "compress", compression: "gzip" });
        expect(errnoCode(error.cause)).toBe("EACCES");
        expect(error.remediation).toMatch(/destination.*writable/iu);
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
    expect(error.cause).toBeInstanceOf(Error);
    expect(transferred).toBe(false);
    expect(await fs.readFile(parent, "utf8")).toBe("keep me");
  });

  // These errno values cannot be produced portably without privileged mounts or exhausting storage.
  test.each([
    ["EPERM", /destination.*writable/iu, false],
    ["EROFS", /destination.*writable/iu, false],
    ["ENOSPC", /disk space/iu, true],
    ["EDQUOT", /quota/iu, true],
    ["ENOENT", /directory/iu, false],
    ["ENOTDIR", /directory/iu, false],
    ["EIO", /destination/iu, false],
    [undefined, /destination/iu, false],
  ] as const)("preserves staging cause and accurate guidance for %s", async (code, guidance, space) => {
    const cause = Object.assign(new Error("staging failed"), { code });
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
      expect(error.cause).toBe(cause);
      expect(error.remediation).toMatch(guidance);
      expect(/disk space|quota/iu.test(error.remediation)).toBe(space);
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
        expect(error.cause).toMatchObject({ _tag: "VerifiedStreamError", cause: { code: "EACCES" } });
        expect(error.remediation).toMatch(/destination.*writable/iu);
        expect(error.remediation).not.toMatch(/disk space/iu);
        expect(await fs.readFile(destination, "utf8")).toBe("previous dump");
      } finally {
        await fs.chmod(root, 0o755);
      }
      expect((await fs.readdir(root)).sort()).toEqual(["dump.sql.gz", "plain.sql"]);
    },
  );

  test("retains a missing source cause instead of diagnosing disk space", async () => {
    const error = failureOf(
      await Effect.runPromiseExit(
        writeDumpTransform(join(root, "missing.sql"), join(root, "dump.sql.gz"), "gzip", "compress"),
      ),
    );
    expect(errnoCode(error.cause)).toBe("ENOENT");
    expect(error.remediation).not.toMatch(/disk space/iu);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
