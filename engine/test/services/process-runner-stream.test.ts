import { expect, test } from "bun:test";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Cause, Effect, Exit, Stream } from "effect";
import { ProcessRunnerLive } from "../../src/services/process-runner";

for (const mode of ["take", "interrupt", "timeout"] as const) {
  test(`kills and reaps a streaming child after ${mode}`, async () => {
    // Given a real child that emits its PID then ignores graceful termination.
    const ready = Promise.withResolvers<number>();
    const controller = new AbortController();
    let output = "";
    const program = Effect.flatMap(ProcessRunner, (runner) => {
      const stream = runner
        .stream({
          cmd: process.execPath,
          args: [
            "-e",
            'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 5000); process.stdout.write(String(process.pid) + "\\n");',
          ],
          ...(mode === "timeout" ? { timeoutMs: 300 } : {}),
        })
        .pipe(
          Stream.tap(({ chunk }) =>
            Effect.sync(() => {
              output += new TextDecoder().decode(chunk);
              if (output.includes("\n")) ready.resolve(Number(output.trim()));
            }),
          ),
        );
      return (mode === "take" ? stream.pipe(Stream.take(1)) : stream).pipe(Stream.runDrain);
    }).pipe(Effect.provide(ProcessRunnerLive));
    const completion = Effect.runPromiseExit(program, { signal: controller.signal });
    let pid: number | undefined;
    try {
      const childPid = await Effect.runPromise(
        Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")),
      );
      pid = childPid;
      // When consumption ends early, is interrupted, or reaches its timeout.
      if (mode === "interrupt") controller.abort();
      const exit = await Effect.runPromise(Effect.promise(() => completion).pipe(Effect.timeout("1 second")));
      // Then termination has reaped the child, not merely stopped the stream fiber.
      expect(Exit.isSuccess(exit)).toBe(mode === "take");
      if (Exit.isFailure(exit) && mode === "timeout") {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag === "Some" && failure.value instanceof ProcessTimeoutError).toBe(true);
      }
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      controller.abort();
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (cause) {
          expect(cause).toMatchObject({ code: "ESRCH" });
        }
      }
      await Effect.runPromise(Effect.promise(() => completion).pipe(Effect.timeout("1 second")));
    }
  }, 4500);
}

test("streaming concurrently drains both pipes and feeds stdin", async () => {
  const chunks = await Effect.runPromise(
    Effect.flatMap(ProcessRunner, (runner) =>
      runner
        .stream({
          cmd: process.execPath,
          args: [
            "-e",
            'process.stdout.write("o".repeat(65536)); process.stderr.write("e".repeat(65536)); const input = await Bun.stdin.text(); process.stdout.write(input);',
          ],
          stdin: "input",
          timeoutMs: 2000,
        })
        .pipe(Stream.runCollect),
    ).pipe(Effect.provide(ProcessRunnerLive)),
  );
  const stdout = [...chunks]
    .filter(({ kind }) => kind === "stdout")
    .map(({ chunk }) => new TextDecoder().decode(chunk))
    .join("");
  const stderr = [...chunks]
    .filter(({ kind }) => kind === "stderr")
    .map(({ chunk }) => new TextDecoder().decode(chunk))
    .join("");
  expect(stdout).toBe(`${"o".repeat(65536)}input`);
  expect(stderr).toBe("e".repeat(65536));
});
