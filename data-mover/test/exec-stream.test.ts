import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option, Stream } from "effect";

import { DataTransferError } from "@lando/sdk/errors";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";

import { execStdoutStream } from "../src/exec-stream.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const failedExit = (exitCode: number | undefined, stderrTail?: string) =>
  new DataTransferError({
    message: "command failed",
    operation: "test",
    exitCode,
    stderrTail,
    remediation: "Fix the fixture command so it exits 0.",
  });

describe("execStdoutStream", () => {
  test.each([false, true])("retains only safe stderr on command failure (upstream=%s)", async (upstream) => {
    const source = Stream.concat(
      Stream.make(
        { kind: "stdout" as const, chunk: bytes("PRIVATE DATABASE PAYLOAD") },
        { kind: "stderr" as const, chunk: bytes("missing database; password: lando\n") },
      ),
      upstream ? Stream.fail("raw provider failure PRIVATE DATABASE PAYLOAD") : Stream.make({ exitCode: 7 }),
    );
    const exit = await Effect.runPromiseExit(
      execStdoutStream(source, failedExit, ["lando"]).pipe(Stream.runDrain),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error.exitCode).toBe(upstream ? undefined : 7);
    expect(error.stderrTail).toContain("missing database");
    expect(JSON.stringify(error)).not.toContain("PRIVATE DATABASE PAYLOAD");
    expect(error.stderrTail).not.toContain("lando");
    expect(error.cause).toBeUndefined();
  });
  test("allocates diagnostics independently for every stream subscription", async () => {
    const source = execStdoutStream(
      Stream.make({ kind: "stderr" as const, chunk: bytes("once\n") }, { exitCode: 1 }),
      failedExit,
    );
    const failures = await Effect.runPromise(
      Effect.all([source.pipe(Stream.runDrain, Effect.result), source.pipe(Stream.runDrain, Effect.result)], {
        concurrency: 2,
      }),
    );
    for (const result of failures) {
      if (result._tag !== "Failure") throw new Error("expected failure");
      expect(result.failure.stderrTail).toBe("once\n");
    }
  });
  test.each([false, true])("keeps the old export file on command failure (upstream=%s)", async (upstream) => {
    const root = await mkdtemp(join(tmpdir(), "lando-failed-export-"));
    const destinationPath = join(root, "existing.sql");
    try {
      await writeFile(destinationPath, "old export");
      const source = Stream.concat(
        Stream.make({ kind: "stdout" as const, chunk: bytes("partial dump") }),
        upstream ? Stream.fail("provider failed") : Stream.make({ exitCode: 3 }),
      );
      const result = await Effect.runPromise(
        Effect.scoped(
          persistVerifiedStream({
            body: execStdoutStream(source, failedExit),
            destinationPath,
          }),
        ).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(await readFile(destinationPath, "utf8")).toBe("old export");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("emits stdout before a later upstream failure", async () => {
    // Given: a command stream with output followed by a failure.
    const source = Stream.concat(
      Stream.make({ kind: "stdout" as const, chunk: bytes("first") }),
      Stream.fail("later"),
    );

    // When: one output chunk is consumed.
    const output = await Effect.runPromise(
      execStdoutStream(source, failedExit).pipe(Stream.take(1), Stream.runCollect),
    );

    // Then: the first chunk is available without collecting the remaining stream.
    expect(Array.from(output).map(text)).toEqual(["first"]);
  });

  test("fails when the command reports a nonzero exit", async () => {
    // Given: a command stream ending with a failed exit.
    const source = Stream.make({ exitCode: 7 });

    // When: the output stream is consumed.
    const exit = await Effect.runPromiseExit(execStdoutStream(source, failedExit).pipe(Stream.runDrain));

    // Then: the exit is converted to the caller's typed transfer failure.
    expect(exit._tag).toBe("Failure");
  });
});
