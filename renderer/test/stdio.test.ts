import { expect, test } from "bun:test";
import { make } from "@lando/renderer/stdio";
import { Effect, Stream } from "effect";

test("Stdio reads Bun-shaped bytes and writes stdout and stderr through injected sinks", async () => {
  const stdout: Array<string | Uint8Array> = [];
  const stderr: Array<string | Uint8Array> = [];
  const bytes = new TextEncoder().encode("input\n");
  const stdio = make({
    stdin: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stdout: (chunk) => {
      stdout.push(chunk);
    },
    stderr: (chunk) => {
      stderr.push(chunk);
    },
    args: ["lando", "mcp"],
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Stream.runCollect(stdio.stdin);
      yield* Stream.run(Stream.make("out\n", bytes), stdio.stdout());
      yield* Stream.run(Stream.make("error\n"), stdio.stderr());
      return { input, args: yield* stdio.args };
    }),
  );
  expect(result.input).toEqual([bytes]);
  expect(result.args).toEqual(["lando", "mcp"]);
  expect(stdout).toEqual(["out\n", bytes]);
  expect(stderr).toEqual(["error\n"]);
});
