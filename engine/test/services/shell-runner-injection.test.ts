import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, type ProcessSpawnOptions, ShellRunner } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import * as BunShellRunner from "../../src/services/shell-runner.ts";

test("the streamed shell fails without embedding the command or a fabricated exit when the child status is absent", async () => {
  const runner = ProcessRunner.of({
    run: () => Effect.die("unexpected collected process"),
    stream: () => Stream.die("unexpected output stream"),
    streamWithExit: () => Stream.empty,
  });
  const shell = BunShellRunner.layer(() => {
    throw new TypeError("Unexpected interactive shell");
  }).pipe(Layer.provide(Layer.succeed(ProcessRunner, runner)));
  const error = await Effect.runPromise(
    Effect.flatMap(ShellRunner, (service) => service.exec("echo private-source")).pipe(
      Effect.provide(shell),
      Effect.flip,
    ),
  );
  expect(error).toMatchObject({ _tag: "ShellExecError", cause: { _tag: "ProcessExecError" } });
  expect(error).not.toHaveProperty("exitCode");
  expect(JSON.stringify(error)).not.toContain("private-source");
});

test.each([true, false])(
  "both shell paths retain the injected process runner with capture=%s",
  async (capture) => {
    const root = await mkdtemp(join(tmpdir(), "lando-shell-injected-"));
    const script = join(root, "injected.bun.sh");
    const calls: ProcessSpawnOptions[] = [];
    const result = { exitCode: 0, stdout: "injected-result", stderr: "injected-diagnostic" };
    const record = (input: ProcessSpawnOptions) =>
      Effect.sync(() => {
        calls.push(input);
        return result;
      });
    const runner = ProcessRunner.of({
      run: record,
      stream: (input) =>
        Stream.unwrap(
          record(input).pipe(
            Effect.as(
              Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(result.stdout) }),
            ),
          ),
        ),
      streamWithExit: (input) =>
        Stream.unwrap(
          record(input).pipe(
            Effect.as(
              Stream.fromIterable([
                { kind: "stdout" as const, chunk: new TextEncoder().encode(result.stdout) },
                { kind: "stderr" as const, chunk: new TextEncoder().encode(result.stderr) },
                { exitCode: result.exitCode },
              ]),
            ),
          ),
        ),
    });
    try {
      await writeFile(script, "exit 93\n");
      const shell = BunShellRunner.layer(() => {
        throw new TypeError("Unexpected interactive shell");
      }).pipe(Layer.provide(Layer.succeed(ProcessRunner, runner)));
      const outputs = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ShellRunner;
          const options = { cwd: root, capture, env: { PWD: "" } };
          return [yield* service.exec("exit 94", options), yield* service.runScript(script, options)];
        }).pipe(Effect.provide(shell)),
      );
      expect(outputs).toEqual([result, result]);
      expect(calls).toHaveLength(2);
      expect(calls.every((input) => input.env?.PWD === "" && input.env?.BUN_BE_BUN === "1")).toBe(true);
      expect(calls[0]?.args).toContain("exec");
      expect(calls[1]?.args).toContain(script);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
