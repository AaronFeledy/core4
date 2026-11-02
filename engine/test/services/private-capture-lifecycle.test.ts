import { expect, test } from "bun:test";
import { ProcessExecError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Exit, Stream } from "effect";
import * as Process from "../../src/services/process-runner.ts";

for (const method of ["run", "streamWithExit"] as const) {
  test.each(["overflow", "abort", "interrupt"] as const)(
    `private ${method} kills and reaps its real child on %s with reads in flight`,
    async (mode) => {
      // Given
      const ready = Promise.withResolvers<number>();
      const controller = new AbortController();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          ready.resolve(Number(await request.text()));
          return new Response("ready");
        },
      });
      const source = `
        process.on("SIGTERM", () => {});
        process.stdout.write("private-payload"); process.stderr.write("private-diagnostic");
        await fetch(${JSON.stringify(server.url.href)}, { method: "POST", body: String(process.pid) });
        ${mode === "overflow" ? "process.stdout.write(new Uint8Array(1048577).fill(255));" : ""}
        setInterval(() => {}, 1000);
      `;
      const options = {
        cmd: process.execPath,
        args: ["-e", source],
        capture: true,
        ...(mode === "abort" ? { signal: controller.signal } : {}),
      };
      const run = Effect.flatMap(ProcessRunner, (runner) =>
        method === "run"
          ? runner.run(options).pipe(Effect.asVoid)
          : runner.streamWithExit(options).pipe(Stream.runDrain),
      ).pipe(Effect.provide(Process.layer));
      const completion = Effect.runPromiseExit(run, { signal: controller.signal });
      let pid: number | undefined;
      try {
        const childPid = await Effect.runPromise(
          Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")),
        );
        pid = childPid;
        // When
        if (mode !== "overflow") controller.abort();
        const exit = await Effect.runPromise(
          Effect.promise(() => completion).pipe(Effect.timeout("2 seconds")),
        );
        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit) && mode === "overflow") {
          expect(
            exit.cause.reasons.some(
              (reason) => reason._tag === "Fail" && reason.error instanceof ProcessExecError,
            ),
          ).toBe(true);
          expect(JSON.stringify(exit)).not.toContain("private-payload");
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
        await server.stop(true);
      }
    },
    5000,
  );
}
