import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, type Context, Effect, Exit, Layer, Queue, Stream } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, ProcessRunner } from "@lando/sdk/services";
import type { LandoEvent } from "@lando/sdk/services";
import { ProcessRunnerLive, awaitSinkResult, resolveProcessCgroup } from "../../src/services/process-runner";

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

const captureEventsLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  } satisfies Context.Tag.Service<typeof EventService>);

const runProcess = (input: Parameters<Context.Tag.Service<typeof ProcessRunner>["run"]>[0]) =>
  Effect.runPromise(
    Effect.flatMap(ProcessRunner, (processRunner) => processRunner.run(input)).pipe(
      Effect.provide(ProcessRunnerLive),
    ),
  );

describe("ProcessRunnerLive", () => {
  for (const mode of ["interrupt", "timeout"] as const) {
    test(`kills and reaps a SIGTERM-resistant child on ${mode}`, async () => {
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
      const program = Effect.flatMap(ProcessRunner, (runner) =>
        runner.run({
          cmd: process.execPath,
          args: [
            "-e",
            `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 5000); await fetch(${JSON.stringify(server.url.href)}, {method:"POST",body:String(process.pid)});`,
          ],
          ...(mode === "timeout" ? { timeoutMs: 300 } : {}),
        }),
      ).pipe(Effect.provide(ProcessRunnerLive));
      const completion = Effect.runPromiseExit(program, { signal: controller.signal });
      let pid: number | undefined;
      try {
        const childPid = await Effect.runPromise(
          Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")),
        );
        pid = childPid;
        if (mode === "interrupt") controller.abort();
        const exit = await Effect.runPromise(
          Effect.promise(() => completion).pipe(Effect.timeout("1 second")),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit) && mode === "timeout") {
          const error = Cause.failureOption(exit.cause);
          expect(error._tag === "Some" && error.value instanceof ProcessTimeoutError).toBe(true);
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
    }, 4000);
  }
  test("observes a late sink failure after exit without waiting for a stuck sink", async () => {
    const lateFailure = new Promise<number>((_, reject) => {
      setTimeout(() => reject(new Error("late sink failure")), 1);
    });
    await expect(awaitSinkResult(lateFailure, Promise.resolve(0))).rejects.toThrow("late sink failure");
    await Promise.race([
      awaitSinkResult(new Promise<number>(() => undefined), Promise.resolve(0)),
      Bun.sleep(250).then(() => {
        throw new Error("ProcessRunner waited for a stuck sink after child exit.");
      }),
    ]);
  });

  test("runs a command and captures stdout", async () => {
    const result = await runProcess({ cmd: "echo", args: ["hello"] });

    expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
  });

  test("preserves stdin and drains both output pipes while the child runs", async () => {
    const result = await runProcess({
      cmd: process.execPath,
      args: [
        "-e",
        'const input = await Bun.stdin.text(); process.stdout.write(input.repeat(65536)); process.stderr.write("e".repeat(65536));',
      ],
      stdin: "input",
      timeoutMs: 2000,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "input".repeat(65536), stderr: "e".repeat(65536) });
  });

  test("returns non-zero exit as data", async () => {
    const result = await runProcess({ cmd: "false", args: [] });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("streams stdin to EOF while draining stdout and stderr and preserving exit code", async () => {
    const payload = new Uint8Array(269_754);
    for (let index = 0; index < payload.length; index += 1) payload[index] = 65 + (index % 26);
    const expected = createHash("sha256").update(payload).digest("hex");
    async function* stdinStream() {
      for (let offset = 0; offset < payload.length; offset += 8192) {
        yield payload.subarray(offset, offset + 8192);
      }
    }

    const result = await runProcess({
      cmd: process.execPath,
      args: [
        "-e",
        'const { createHash } = await import("node:crypto"); const bytes = new Uint8Array(await Bun.stdin.arrayBuffer()); process.stdout.write(createHash("sha256").update(bytes).digest("hex")); process.stderr.write(String(bytes.length)); process.exitCode = 37;',
      ],
      stdinStream: stdinStream(),
    });

    expect(result).toEqual({ exitCode: 37, stdout: expected, stderr: "269754" });
  });

  test("stream drains output after streamed stdin reaches EOF", async () => {
    async function* stdinStream() {
      yield new TextEncoder().encode("streamed-input");
    }
    const chunks = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) =>
        runner
          .stream({
            cmd: process.execPath,
            args: [
              "-e",
              'const text = await Bun.stdin.text(); process.stdout.write(text); process.stderr.write("done");',
            ],
            stdinStream: stdinStream(),
          })
          .pipe(Stream.runCollect),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect([...chunks].map((chunk) => [chunk.kind, new TextDecoder().decode(chunk.chunk)])).toEqual([
      ["stdout", "streamed-input"],
      ["stderr", "done"],
    ]);
  });

  test("streamWithExit emits output before the final nonzero exit code", async () => {
    async function* stdinStream() {
      yield new TextEncoder().encode("duplex");
    }
    const events = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) =>
        runner
          .streamWithExit({
            cmd: process.execPath,
            args: [
              "-e",
              'const text = await Bun.stdin.text(); process.stdout.write(text); process.stderr.write("done"); process.exitCode = 37;',
            ],
            stdinStream: stdinStream(),
          })
          .pipe(Stream.runCollect),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(
      [...events].map((event) =>
        "exitCode" in event ? event.exitCode : [event.kind, new TextDecoder().decode(event.chunk)],
      ),
    ).toEqual([["stdout", "duplex"], ["stderr", "done"], 37]);
  });

  test("run and stream finish when a child exits before its stdin source closes", async () => {
    async function* stalledStdin() {
      yield new TextEncoder().encode("first");
      await new Promise<void>(() => undefined);
    }
    const command = {
      cmd: process.execPath,
      args: ["-e", 'process.stdout.write("done");'],
    };
    const run = runProcess({ ...command, stdinStream: stalledStdin() });
    const streamed = Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) =>
        runner.streamWithExit({ ...command, stdinStream: stalledStdin() }).pipe(Stream.runCollect),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );
    const [result, events] = await Promise.race([
      Promise.all([run, streamed]),
      Bun.sleep(2_000).then(() => {
        throw new Error("ProcessRunner waited for stdin after the child exited.");
      }),
    ]);
    expect(result).toEqual({ exitCode: 0, stdout: "done", stderr: "" });
    expect([...events].at(-1)).toEqual({ exitCode: 0 });
  });

  test("run and streamWithExit deliver direct stdin to EOF", async () => {
    const command = {
      cmd: process.execPath,
      args: ["-e", "process.stdout.write(await Bun.stdin.text());"],
      stdin: "direct-input",
    };
    const result = await runProcess(command);
    const events = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) => runner.streamWithExit(command).pipe(Stream.runCollect)).pipe(
        Effect.provide(ProcessRunnerLive),
      ),
    );
    expect(result).toEqual({ exitCode: 0, stdout: "direct-input", stderr: "" });
    expect(
      [...events].map((event) =>
        "exitCode" in event ? event.exitCode : new TextDecoder().decode(event.chunk),
      ),
    ).toEqual(["direct-input", 0]);
  });

  test("run and streamWithExit return an early exit with large direct stdin", async () => {
    const stdin = new Uint8Array(4 * 1024 * 1024);
    const command = {
      cmd: process.execPath,
      args: ["-e", 'process.stdout.write("done"); process.exitCode = 37;'],
      stdin,
    };
    const result = await runProcess(command);
    const events = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) => runner.streamWithExit(command).pipe(Stream.runCollect)).pipe(
        Effect.provide(ProcessRunnerLive),
      ),
    );
    expect(result).toEqual({ exitCode: 37, stdout: "done", stderr: "" });
    expect([...events].at(-1)).toEqual({ exitCode: 37 });
  });

  test("direct stdin still reports EPIPE while the child remains alive", async () => {
    const command = {
      cmd: process.execPath,
      args: ["-e", 'require("node:fs").closeSync(0); await Bun.sleep(1000);'],
      stdin: new Uint8Array(4 * 1024 * 1024),
    };
    await expect(runProcess(command)).rejects.toThrow("EPIPE");
    await expect(
      Effect.runPromise(
        Effect.flatMap(ProcessRunner, (runner) =>
          runner.streamWithExit(command).pipe(Stream.runCollect),
        ).pipe(Effect.provide(ProcessRunnerLive)),
      ),
    ).rejects.toThrow("EPIPE");
  });

  test("preserves stdin producer failures while the child is running", async () => {
    async function* failingStdin(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0);
      throw new Error("stdin producer failed");
    }
    const command = { cmd: process.execPath, args: ["-e", "await Bun.sleep(500);"] };
    await expect(runProcess({ ...command, stdinStream: failingStdin() })).rejects.toThrow(
      "stdin producer failed",
    );
    await expect(
      Effect.runPromise(
        Effect.flatMap(ProcessRunner, (runner) =>
          runner.streamWithExit({ ...command, stdinStream: failingStdin() }).pipe(Stream.runCollect),
        ).pipe(Effect.provide(ProcessRunnerLive)),
      ),
    ).rejects.toThrow("stdin producer failed");
  });

  test("preserves stdin pipe failures while the child remains alive", async () => {
    async function* stdinStream() {
      yield new Uint8Array(1024 * 1024);
    }
    const command = {
      cmd: process.execPath,
      args: ["-e", 'require("node:fs").closeSync(0); await Bun.sleep(1000);'],
    };
    await expect(runProcess({ ...command, stdinStream: stdinStream() })).rejects.toThrow("EPIPE");
    await expect(
      Effect.runPromise(
        Effect.flatMap(ProcessRunner, (runner) =>
          runner.streamWithExit({ ...command, stdinStream: stdinStream() }).pipe(Stream.runCollect),
        ).pipe(Effect.provide(ProcessRunnerLive)),
      ),
    ).rejects.toThrow("EPIPE");
  });

  test("streamWithExit applies output backpressure when the consumer pauses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-process-backpressure-"));
    const marker = join(directory, "finished");
    let checked = false;
    try {
      await Effect.runPromise(
        Effect.flatMap(ProcessRunner, (runner) =>
          runner
            .streamWithExit({
              cmd: process.execPath,
              args: [
                "-e",
                'const fs = require("node:fs"); const chunk = Buffer.alloc(65536, 65); for (let i = 0; i < 128; i++) fs.writeSync(1, chunk); fs.writeFileSync(process.argv[1], "done");',
                marker,
              ],
            })
            .pipe(
              Stream.runForEach((event) => {
                if ("exitCode" in event || checked) return Effect.void;
                checked = true;
                return Effect.promise(async () => {
                  await Bun.sleep(200);
                  expect(await Bun.file(marker).exists()).toBe(false);
                });
              }),
            ),
        ).pipe(Effect.provide(ProcessRunnerLive)),
      );
      expect(checked).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails with ProcessExecError when executable is missing", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "definitely-not-a-binary", args: [] }),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProcessExecError);
        if (!(failure.value instanceof ProcessExecError)) throw new Error("expected ProcessExecError");
        expect(failure.value.cmd).toBe("definitely-not-a-binary");
        expect(failure.value.errno).toBeDefined();
      }
    }
  });

  test("redacts constructed ProcessExecError fields when RedactionService is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-process-topsecret-"));
    try {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ProcessRunner, (processRunner) =>
          processRunner.run({ cmd: "missing-topsecret-binary", args: [], cwd }),
        ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProcessExecError);
          expect(failure.value.message).toContain("[redacted]");
          expect(failure.value.message).not.toContain("topsecret");
          expect(failure.value.cmd).toBe("missing-[redacted]-binary");
          expect(failure.value.cwd).toContain("[redacted]");
          expect(failure.value.cwd).not.toContain("topsecret");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("timeout fails with ProcessTimeoutError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "bun", args: ["-e", "await new Promise(() => {})"], timeoutMs: 50 }),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProcessTimeoutError);
        if (!(failure.value instanceof ProcessTimeoutError)) throw new Error("expected ProcessTimeoutError");
        expect(failure.value.elapsedMs).toBeGreaterThanOrEqual(50);
      }
    }
  });

  test("redacts constructed ProcessTimeoutError fields when RedactionService is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-timeout-topsecret-"));
    const bunLink = join(cwd, "bun-topsecret");
    try {
      await symlink(process.execPath, bunLink);
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ProcessRunner, (processRunner) =>
          processRunner.run({
            cmd: bunLink,
            args: ["-e", "await new Promise(() => {})"],
            cwd,
            timeoutMs: 50,
          }),
        ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProcessTimeoutError);
          expect(failure.value.message).toContain("[redacted]");
          expect(failure.value.message).not.toContain("topsecret");
          expect(failure.value.cmd).toContain("[redacted]");
          expect(failure.value.cmd).not.toContain("topsecret");
          expect(failure.value.cwd).toContain("[redacted]");
          expect(failure.value.cwd).not.toContain("topsecret");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not redact successful ProcessResult data", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "bun", args: ["-e", "console.log('topsecret')"] }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(result.stdout).not.toContain("[redacted]");
  });

  test("redacts successful pre/post process event payloads when RedactionService is present", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({
          cmd: "bun",
          args: ["-e", "console.log(process.env.BUN_AUTH_TOKEN)"],
          env: { BUN_AUTH_TOKEN: "topsecret" },
        }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events.map((event) => event._tag)).toEqual(["pre-process-exec", "post-process-exec"]);
    const payload = JSON.stringify(events);
    expect(payload).not.toContain("topsecret");
    expect(payload).toContain("[redacted]");
  });

  test("does not publish process exec events without RedactionService", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({
          cmd: "bun",
          args: ["-e", "console.log(process.env.BUN_AUTH_TOKEN)"],
          env: { BUN_AUTH_TOKEN: "topsecret" },
        }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events).toEqual([]);
  });

  test("streams stdout and stderr chunks", async () => {
    const chunks = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner
          .stream({
            cmd: "bun",
            args: ["-e", "console.log('out'); console.error('err')"],
          })
          .pipe(Stream.runCollect),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    const decoded = Array.from(chunks).map((chunk) => ({
      kind: chunk.kind,
      text: new TextDecoder().decode(chunk.chunk),
    }));

    expect(decoded.some((chunk) => chunk.kind === "stdout" && chunk.text.includes("out"))).toBe(true);
    expect(decoded.some((chunk) => chunk.kind === "stderr" && chunk.text.includes("err"))).toBe(true);
  });
});

describe("resolveProcessCgroup", () => {
  test("passes cgroup through on Linux", () => {
    expect(resolveProcessCgroup("/sys/fs/cgroup/jobs", "linux")).toBe("/sys/fs/cgroup/jobs");
  });

  test("ignores cgroup on non-Linux platforms", () => {
    expect(resolveProcessCgroup("/sys/fs/cgroup/jobs", "darwin")).toBeUndefined();
    expect(resolveProcessCgroup("/sys/fs/cgroup/jobs", "win32")).toBeUndefined();
  });

  test("omits empty and unset values", () => {
    expect(resolveProcessCgroup(undefined, "linux")).toBeUndefined();
    expect(resolveProcessCgroup("", "linux")).toBeUndefined();
  });
});

describe("ProcessRunnerLive cgroup", () => {
  test("ignores cgroup off Linux and fails ProcessExecError for a missing cgroup on Linux", async () => {
    if (process.platform !== "linux") {
      const result = await runProcess({ cmd: "true", args: [], cgroup: "/sys/fs/cgroup/jobs" });
      expect(result.exitCode).toBe(0);
      return;
    }
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({
          cmd: "true",
          args: [],
          cgroup: "/sys/fs/cgroup/lando-definitely-missing-cgroup",
        }),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProcessExecError);
      }
    }
  });
});
