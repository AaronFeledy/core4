import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandStdioError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { prepareImportDump } from "../src/dump-file.ts";

let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "lando-import-io-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const prepare = (
  stagingDir: string,
  stdin: Stream.Stream<Uint8Array, CommandStdioError> = Stream.make(new TextEncoder().encode("select 1;")),
) =>
  Effect.scoped(
    prepareImportDump({
      file: "-",
      appRoot: root,
      stagingDir,
      stdin,
      completeness: undefined,
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    }),
  );
const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

test("stdin staging reports an invalid staging path without a codec diagnosis", async () => {
  const stagingDir = join(root, "file");
  await fs.writeFile(stagingDir, "keep");
  const error = failureOf(await Effect.runPromiseExit(prepare(stagingDir)));
  expect(error).toMatchObject({
    _tag: "DataTransferError",
    operation: "stage",
    toEndpoint: "hostPath",
    cause: { _tag: "FileIoError", path: stagingDir, operation: "stage", reason: "invalid-path" },
  });
  expect(await fs.readFile(stagingDir, "utf8")).toBe("keep");
});

test("stdin staging normalizes a full filesystem at the directory creation owner", async () => {
  const stagingDir = join(root, "stage");
  const create = spyOn(fs, "mkdtemp").mockRejectedValueOnce(
    Object.assign(new Error("private bytes"), { code: "ENOSPC" }),
  );
  try {
    const error = failureOf(await Effect.runPromiseExit(prepare(stagingDir)));
    expect(error).toMatchObject({
      _tag: "DataTransferError",
      operation: "stage",
      cause: { _tag: "FileIoError", path: stagingDir, operation: "stage", reason: "no-space" },
    });
    expect(JSON.stringify(error)).not.toContain("private bytes");
    expect(await fs.readdir(stagingDir)).toEqual([]);
  } finally {
    create.mockRestore();
  }
});

test("plaintext stdin persistence retains the normalized destination role", async () => {
  const stagingDir = join(root, "stage");
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(
    Object.assign(new Error("private bytes"), { code: "ENOENT" }),
  );
  try {
    const error = failureOf(await Effect.runPromiseExit(prepare(stagingDir)));
    expect(error).toMatchObject({
      _tag: "DataTransferError",
      operation: "persist",
      toEndpoint: "hostPath",
      cause: { _tag: "FileIoError", operation: "persist", reason: "not-found" },
    });
    expect(JSON.stringify(error)).not.toContain("private bytes");
    expect(await fs.readdir(stagingDir)).toEqual([]);
  } finally {
    rename.mockRestore();
  }
});

test.each(["gzip", "zstd"] as const)(
  "%s native decompressor initialization failures remain codec errors",
  async (compression) => {
    const cause = Object.assign(new Error("codec failed"), { code: "ENOSPC" });
    const codec = globalThis.DecompressionStream;
    globalThis.DecompressionStream = class extends codec {
      constructor(...args: ConstructorParameters<typeof codec>) {
        super(...args);
        throw cause;
      }
    };
    try {
      const bytes = compression === "gzip" ? Bun.gzipSync("select 1;") : Bun.zstdCompressSync("select 1;");
      const error = failureOf(await Effect.runPromiseExit(prepare(join(root, "stage"), Stream.make(bytes))));
      expect(error).toMatchObject({
        _tag: "SqlDumpCompressionError",
        compression,
        operation: "decompress",
        cause,
      });
      expect(await fs.readdir(join(root, "stage"))).toEqual([]);
    } finally {
      globalThis.DecompressionStream = codec;
    }
  },
);
