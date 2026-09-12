import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

import { DataTransferError } from "@lando/sdk/errors";

import { execStdoutStream } from "../src/exec-stream.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const failedExit = (exitCode: number) =>
  new DataTransferError({ message: "command failed", operation: "test", cause: { exitCode } });

describe("execStdoutStream", () => {
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
