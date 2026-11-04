import { expect, test } from "bun:test";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { layer } from "../../src/services/process-runner.ts";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
};

for (const mode of ["interrupt", "timeout"] as const) {
  test.skipIf(process.platform === "win32")(
    `issue #2014: captured ${mode} kills the child and its SIGTERM-resistant descendant`,
    async () => {
      const ready = Promise.withResolvers<readonly number[]>();
      const controller = new AbortController();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          ready.resolve((await request.text()).split(",").map(Number));
          return new Response("ready");
        },
      });
      const descendant = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await fetch(${JSON.stringify(server.url.href)}, { method: "POST", body: [process.ppid, process.pid].join(",") });`;
      const completion = Effect.runPromiseExit(
        Effect.flatMap(ProcessRunner, (runner) =>
          runner.run({
            cmd: process.execPath,
            args: [
              "-e",
              `process.on("SIGTERM", () => {}); const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], { stdout: "inherit", stderr: "inherit" }); await child.exited;`,
            ],
            capture: true,
            ...(mode === "timeout" ? { timeoutMs: 1000 } : {}),
          }),
        ).pipe(Effect.provide(layer)),
        { signal: controller.signal },
      );
      let pids: readonly number[] = [];
      try {
        pids = await Effect.runPromise(Effect.promise(() => ready.promise).pipe(Effect.timeout("3 seconds")));
        expect(pids).toHaveLength(2);
        expect(pids.every(isAlive)).toBe(true);
        if (mode === "interrupt") controller.abort();
        const exit = await Effect.runPromise(
          Effect.promise(() => completion).pipe(Effect.timeout("3 seconds")),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit) && mode === "timeout") {
          const error = Cause.findErrorOption(exit.cause);
          expect(error._tag === "Some" && error.value instanceof ProcessTimeoutError).toBe(true);
        }
        const deadline = performance.now() + 2000;
        while (pids.some(isAlive) && performance.now() < deadline) await Bun.sleep(10);
        expect(pids.filter(isAlive)).toEqual([]);
      } finally {
        controller.abort();
        for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
        await server.stop(true);
      }
    },
    8000,
  );
}

test.skipIf(process.platform === "win32")("inherited stdin keeps the parent's process group", async () => {
  const result = await Effect.runPromise(
    Effect.flatMap(ProcessRunner, (runner) =>
      runner.run({
        cmd: "sh",
        args: ["-c", "ps -o pgid= -p $$; ps -o pgid= -p $PPID"],
        capture: true,
        inheritStdin: true,
      }),
    ).pipe(Effect.provide(layer)),
  );
  const groups = result.stdout.trim().split(/\s+/u);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toBe(groups[1]);
});

test.skipIf(process.platform === "win32")("streaming runs keep the parent's process group", async () => {
  const result = await Effect.runPromise(
    Effect.flatMap(ProcessRunner, (runner) =>
      runner.run({ cmd: "sh", args: ["-c", "ps -o pgid= -p $$; ps -o pgid= -p $PPID"] }),
    ).pipe(Effect.provide(layer)),
  );
  const groups = result.stdout.trim().split(/\s+/u);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toBe(groups[1]);
});

test.skipIf(process.platform === "win32")("early host exit kills its registered detached child", async () => {
  const runner = JSON.stringify(new URL("../../src/services/process-runner.ts", import.meta.url).pathname);
  const program = `
    import { Effect } from "effect";
    import { ProcessRunner } from "@lando/sdk/services";
    import { layer } from ${runner};
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      process.stdout.write(await request.text());
      process.exit(23);
    }});
    await Effect.runPromise(Effect.flatMap(ProcessRunner, runner => runner.run({
      cmd: process.execPath,
      args: ["-e", 'setInterval(() => {}, 1000); void fetch(' + JSON.stringify(server.url.href) + ', { method: "POST", body: String(process.pid) }).catch(cause => String(cause)); await new Promise(() => {});'],
      capture: true,
    })).pipe(Effect.provide(layer)));
  `;
  const host = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" });
  const output = new Response(host.stdout).text();
  const errors = new Response(host.stderr).text();
  let pid: number | undefined;
  try {
    const code = await Effect.runPromise(Effect.promise(() => host.exited).pipe(Effect.timeout("3 seconds")));
    expect(code, await errors).toBe(23);
    pid = Number(await output);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const deadline = performance.now() + 2000;
    while (isAlive(pid) && performance.now() < deadline) await Bun.sleep(10);
    expect(isAlive(pid)).toBe(false);
  } finally {
    if (host.exitCode === null) host.kill("SIGKILL");
    await host.exited;
    if (pid !== undefined && Number.isInteger(pid) && pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
  }
});
