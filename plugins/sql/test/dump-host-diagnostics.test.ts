import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataTransferError, FileIoError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";
import { writeDumpTransform } from "../src/compression.ts";
import { prepareImportDump } from "../src/dump-file.ts";

let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "lando-host-diagnostics-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};
const prepare = (path: string) =>
  prepareImportDump({
    file: path,
    appRoot: root,
    stagingDir: join(root, "stage"),
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    completeness: undefined,
  });

test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "an admitted import that loses read permission reports source/read",
  async () => {
    const path = join(root, "source.sql");
    await fs.writeFile(path, "select 1;");
    await fs.chmod(path, 0);
    const error = failureOf(await Effect.runPromiseExit(Effect.scoped(prepare(path))));
    expect(error).toMatchObject({
      _tag: "DataTransferError",
      fromEndpoint: "hostPath",
      operation: "read",
      cause: { _tag: "FileIoError", path, operation: "read", reason: "permission-denied" },
    });
    expect(await fs.readdir(root)).toEqual(["source.sql"]);
  },
);

for (const compression of ["none", "gzip", "zstd"] as const) {
  test(`${compression} import preserves the source/read role for unknown errors after admission`, async () => {
    const path = join(root, "source.sql");
    const file = Bun.file(path);
    const bytes = new TextEncoder().encode("select 1;");
    const prefix =
      compression === "gzip"
        ? Bun.gzipSync(bytes)
        : compression === "zstd"
          ? Bun.zstdCompressSync(bytes)
          : bytes;
    let reads = 0;
    const stream = spyOn(file, "stream").mockReturnValue(
      new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(prefix.subarray(0, 4));
          else
            controller.error(
              Object.assign(new Error("private SQL payload"), { code: "UNRECOGNIZED", secret: "password" }),
            );
        },
      }),
    );
    const open = spyOn(Bun, "file").mockReturnValue(file);
    try {
      const error = failureOf(await Effect.runPromiseExit(Effect.scoped(prepare(path))));
      expect(error).toBeInstanceOf(DataTransferError);
      expect(error).toMatchObject({
        fromEndpoint: "hostPath",
        operation: "read",
        cause: { _tag: "FileIoError", operation: "read", reason: "unknown", path },
      });
      expect(JSON.stringify(error)).not.toMatch(/private SQL payload|UNRECOGNIZED|password/u);
      expect(await fs.readdir(root)).toEqual(compression === "none" ? [] : ["stage"]);
      if (compression !== "none") expect(await fs.readdir(join(root, "stage"))).toEqual([]);
    } finally {
      open.mockRestore();
      stream.mockRestore();
    }
  });
}

for (const compression of ["gzip", "zstd"] as const) {
  test(`${compression} export normalizes unknown read failures before the codec`, async () => {
    const path = join(root, "source.sql");
    const file = Bun.file(path);
    const stream = spyOn(file, "stream").mockReturnValue(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("private source bytes"));
        },
      }),
    );
    const open = spyOn(Bun, "file").mockReturnValue(file);
    try {
      const error = failureOf(
        await Effect.runPromiseExit(writeDumpTransform(path, join(root, "out"), compression, "compress")),
      );
      expect(error).toMatchObject({
        _tag: "DataTransferError",
        operation: "read",
        fromEndpoint: "hostPath",
        cause: { _tag: "FileIoError", path, operation: "read", reason: "unknown" },
      });
      expect(JSON.stringify(error)).not.toContain("private source bytes");
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      open.mockRestore();
      stream.mockRestore();
    }
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    `${compression} export reports an unreadable source`,
    async () => {
      const path = join(root, "source.sql");
      await fs.writeFile(path, "select 1;");
      await fs.chmod(path, 0);
      const error = failureOf(
        await Effect.runPromiseExit(writeDumpTransform(path, join(root, "out"), compression, "compress")),
      );
      expect(error).toMatchObject({
        _tag: "DataTransferError",
        operation: "read",
        cause: { _tag: "FileIoError", path, operation: "read", reason: "permission-denied" },
      });
      expect(await fs.readdir(root)).toEqual(["source.sql"]);
    },
  );

  test(`${compression} import persistence keeps the normalized destination cause and cleans staging`, async () => {
    const path = join(root, "source.sql");
    await fs.writeFile(
      path,
      compression === "gzip" ? Bun.gzipSync("select 1;") : Bun.zstdCompressSync("select 1;"),
    );
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("private destination"), { code: "ENOSPC" }),
    );
    try {
      const error = failureOf(await Effect.runPromiseExit(Effect.scoped(prepare(path))));
      expect(error).toBeInstanceOf(DataTransferError);
      if (!(error instanceof DataTransferError) || !(error.cause instanceof FileIoError))
        throw new Error("expected safe transfer");
      expect(error).toMatchObject({ operation: "persist", toEndpoint: "hostPath" });
      expect(error.cause).toMatchObject({ operation: "persist", reason: "no-space" });
      expect(error.cause.path).toMatch(new RegExp(`^${join(root, "stage")}/sql-dump-[^/]+/dump$`, "u"));
      expect(error.remediation).toBe(error.cause.remediation);
      expect(JSON.stringify(error)).not.toContain("private destination");
      expect(await fs.readdir(join(root, "stage"))).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });
}

test.each([2, 3])(
  "privacy callback failure at access %s retains its type and cleans staging",
  async (access) => {
    const path = join(root, "source.gz");
    await fs.writeFile(path, Bun.gzipSync("select 1;"));
    const failure = new FileIoError({
      message: "ACL policy refused",
      path,
      remediation: "Restore the ACL policy.",
    });
    let calls = 0;
    const error = failureOf(
      await Effect.runPromiseExit(
        Effect.scoped(
          prepareImportDump({
            file: path,
            appRoot: root,
            stagingDir: join(root, "stage"),
            completeness: undefined,
            privateFileAccess: {
              enforce: async () => {
                if (++calls === access) throw failure;
              },
              verify: async () => undefined,
            },
          }),
        ),
      ),
    );
    expect(error).toBe(failure);
    expect(await fs.readdir(join(root, "stage"))).toEqual([]);
  },
);
