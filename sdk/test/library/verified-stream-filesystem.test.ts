import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { FileIoError } from "@lando/sdk/errors";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";
import { Effect, Exit, Schema, Stream, absurd } from "effect";

test.each([
  ["stat", "EACCES", "permission-denied"],
  ["mkdir", "EROFS", "read-only"],
  ["open", "EDQUOT", "quota-exceeded"],
  ["write", "ENOSPC", "no-space"],
  ["chmod", "EPERM", "permission-denied"],
  ["close", "EIO", "io"],
  ["recheck", "EIO", "io"],
  ["rename", "ENOENT", "not-found"],
] as const)("%s failure retains a safe destination cause", async (syscall, code, reason) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lando-persist-errno-"));
  const destination = join(directory, "dump.sql");
  const native = Object.assign(new Error("HOSTILE_MESSAGE"), {
    code,
    stack: "HOSTILE_STACK",
    payload: "HOSTILE_PAYLOAD",
    cause: { _tag: "NativeNested", message: "HOSTILE_CAUSE" },
  });
  await fs.writeFile(destination, "original");
  const originalOpen = fs.open;
  const originalStat = fs.stat;
  const fault = (() => {
    switch (syscall) {
      case "stat":
      case "mkdir":
      case "open":
      case "chmod":
      case "rename":
        return spyOn(fs, syscall).mockRejectedValue(native);
      case "recheck":
        return spyOn(fs, "stat").mockImplementationOnce(originalStat).mockRejectedValue(native);
      case "write":
        return spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await originalOpen(...args);
          spyOn(handle, "write").mockRejectedValue(native);
          return handle;
        });
      case "close":
        return spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await originalOpen(...args);
          const close = handle.close.bind(handle);
          spyOn(handle, "close").mockImplementationOnce(async () => {
            await close();
            throw native;
          });
          return handle;
        });
      default:
        return absurd<never>(syscall);
    }
  })();
  try {
    const error = await Effect.runPromise(
      Effect.scoped(
        persistVerifiedStream({
          body: Stream.make(new TextEncoder().encode("private dump bytes")),
          destinationPath: destination,
          randomId: () => "diagnostic",
          mode: 0o600,
        }),
      ).pipe(Effect.flip),
    );

    expect(error.reason).toBe("persist");
    expect(error.cause).toBeInstanceOf(FileIoError);
    expect(error.cause).toMatchObject({ path: destination, operation: "persist", reason });
    expect(JSON.stringify(error)).not.toMatch(/HOSTILE_|private dump bytes/u);
    const line = Effect.runSync(
      encodeCommandResult({
        command: "db:export",
        resultSchema: Schema.Void,
        outcome: { _tag: "failure", error, additionalErrors: [] },
        redactor: identityRedactor,
      }),
    );
    expect(JSON.parse(line).error.cause).toMatchObject({
      _tag: "FileIoError",
      path: destination,
      operation: "persist",
      reason,
    });
    expect(line).not.toMatch(/HOSTILE_|private dump bytes/u);
    expect(await fs.readFile(destination, "utf8")).toBe("original");
    expect(await fs.readdir(directory)).toEqual(["dump.sql"]);
  } finally {
    fault.mockRestore();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persistence failure preserves the source cleanup defect alongside the safe I/O cause", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lando-persist-cleanup-"));
  const destination = join(directory, "dump.sql");
  const cleanup = new Error("source cleanup failed");
  const originalOpen = fs.open;
  const fault = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    spyOn(handle, "write").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    return handle;
  });
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        persistVerifiedStream({
          destinationPath: destination,
          body: Stream.make(new Uint8Array([1])).pipe(Stream.ensuring(Effect.die(cleanup))),
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toMatchObject([
        {
          _tag: "Fail",
          error: {
            _tag: "VerifiedStreamError",
            reason: "persist",
            cause: {
              _tag: "FileIoError",
              operation: "persist",
              reason: "no-space",
              path: destination,
            },
          },
        },
        { _tag: "Die", defect: cleanup },
      ]);
    }
    expect(await fs.readdir(directory)).toEqual([]);
  } finally {
    fault.mockRestore();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each([
  Object.assign(new Error("codec failure"), { code: "ENOSPC" }),
  new FileIoError({ path: "/source", message: "Source failed.", remediation: "Repair the source." }),
])("source failure passes through unchanged: %p", async (sourceError) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lando-source-error-"));
  try {
    const error = await Effect.runPromise(
      Effect.scoped(
        persistVerifiedStream({
          body: Stream.fail(sourceError),
          destinationPath: join(directory, "dump.sql"),
        }),
      ).pipe(Effect.flip),
    );
    expect(error).toBe(sourceError);
    expect(await fs.readdir(directory)).toEqual([]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
