import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { createStdioRendererIO } from "@lando/renderer/io";
import { writeResultLine } from "@lando/renderer/output";
import { Deferred, Effect, Layer } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

const fakeStream = (breakOn = Number.POSITIVE_INFINITY) => {
  const chunks: string[] = [];
  let writes = 0;
  const stream = Object.assign(new Socket(), {
    write: (chunk: string) => {
      writes += 1;
      if (writes === breakOn) throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      chunks.push(chunk);
      return true;
    },
    isTTY: false,
    columns: 80,
    rows: 24,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    getWindowSize: (): [number, number] => [80, 24],
    getColorDepth: () => 1,
    hasColors: () => false,
  });
  return { stream, chunks };
};

const fakeStdin = {
  isTTY: false,
  isPaused: () => true,
  setRawMode: () => {},
  resume: () => {},
  pause: () => {},
  on: () => {},
  off: () => {},
};

const verifyBrokenStdoutInterrupts = async (): Promise<void> => {
  // Given: only one stdout notification exists per process; this scenario owns it.
  const stdout = fakeStream(3);
  const stderr = fakeStream();
  const exitCodes: number[] = [];
  const originalExitCode = process.exitCode;
  const stop = Effect.runSync(Deferred.make<void>());
  let finalized = false;
  const command = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        finalized = true;
      }),
    );
    yield* writeResultLine("line").pipe(Effect.andThen(Effect.sleep("5 millis")), Effect.forever);
  }).pipe(Effect.scoped, Effect.raceFirst(Deferred.await(stop)));
  // When
  const running = runWithRendererHandling(command, {
    runtime: Layer.empty,
    rendererMode: "plain",
    io: createStdioRendererIO(stdout.stream, stderr.stream, fakeStdin),
    formatError: ({ error }) => String(error),
    setExitCode: (code) => {
      exitCodes.push(code);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      running.then(() => "resolved"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 2000);
      }),
    ]);
    // Then: injected IO completes cleanup quietly without changing the host process status.
    expect(outcome).toBe("resolved");
    expect(finalized).toBe(true);
    expect(stderr.chunks.join("")).toBe("");
    expect(exitCodes).toEqual([]);
    expect(process.exitCode).toBe(originalExitCode);
  } finally {
    clearTimeout(timer);
    await Effect.runPromise(Deferred.succeed(stop, undefined));
    await running;
  }
};

test("a command that writes forever is interrupted when stdout breaks, resolves, and writes no diagnostic", async () => {
  if (process.env.LANDO_TEST_BROKEN_STDOUT_CHILD === "1") {
    await verifyBrokenStdoutInterrupts();
    return;
  }

  // Destination notifications are process-lifetime state. Run this scenario
  // in its own Bun test process so an earlier EPIPE cannot consume its signal.
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-orphans", "test", import.meta.path],
    cwd: resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, LANDO_TEST_BROKEN_STDOUT_CHILD: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  expect(stderr).toMatch(/2 pass\s*\n\s*0 fail/u);
});

test("finalizers still run when a stream breaks", async () => {
  // Given: a finite command must also close its scope when its first write breaks.
  const stdout = fakeStream(1);
  const stderr = fakeStream();
  let finalized = false;
  const command = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        finalized = true;
      }),
    );
    yield* writeResultLine("line");
  }).pipe(Effect.scoped);
  // When
  const result = await runWithRendererHandling(command, {
    runtime: Layer.empty,
    rendererMode: "plain",
    io: createStdioRendererIO(stdout.stream, stderr.stream, fakeStdin),
    formatError: ({ error }) => String(error),
    setExitCode: () => {},
  });
  // Then
  expect(result).toBeUndefined();
  expect(finalized).toBe(true);
  expect(stderr.chunks.join("")).toBe("");
});
