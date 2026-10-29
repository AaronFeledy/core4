import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ProcessExecError, type ProcessTimeoutError, ShellExecError } from "@lando/sdk/errors";
import {
  EventService,
  type LandoEvent,
  type ProcessResult,
  ProcessRunner,
  ShellRunner,
} from "@lando/sdk/services";
import { Effect, Queue, Stream } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import * as Process from "../../src/services/process-runner.ts";
import * as Shell from "../../src/services/shell-runner.ts";

const limit = 1024 * 1024;
const shellLayer = Shell.layer(() => {
  throw new TypeError("Unused interactive IO");
});
const processRun = (source: string, capture = true) =>
  Effect.flatMap(ProcessRunner, (runner) =>
    runner.run({
      cmd: process.execPath,
      args: ["-e", source],
      capture,
    }),
  ).pipe(Effect.provide(Process.layer));

test.each(["stdout", "stderr"] as const)("rejects private %s overflow quietly", async (channel) => {
  // Given
  const source = `process.${channel}.write("private-payload".repeat(90000));`;
  // When
  const error = await Effect.runPromise(processRun(source).pipe(Effect.flip));
  // Then
  expect(error).toBeInstanceOf(ProcessExecError);
  expect(JSON.stringify(error)).not.toContain("private-payload");
  expect(JSON.stringify(error).length).toBeLessThan(2048);
  expect(error).not.toHaveProperty("exitCode");
});

test("accepts the exact private byte limit independently for both channels", async () => {
  // Given
  const source = `process.stdout.write("é".repeat(${limit / 2})); process.stderr.write("x".repeat(${limit}));`;
  // When
  const result = await Effect.runPromise(processRun(source));
  // Then
  expect(result).toEqual({ exitCode: 0, stdout: "é".repeat(limit / 2), stderr: "x".repeat(limit) });
});

test("leaves ordinary large output unlimited", async () => {
  // Given
  const source = `process.stdout.write("x".repeat(${limit + 1}));`;
  // When
  const result = await Effect.runPromise(processRun(source, false));
  // Then
  expect(result.stdout).toBe("x".repeat(limit + 1));
});

test("private process execution preserves stdin and nonzero exit as data", async () => {
  // Given
  const input = "raw-private-input";
  // When
  const result = await Effect.runPromise(
    Effect.flatMap(ProcessRunner, (runner) =>
      runner.run({
        cmd: process.execPath,
        args: [
          "-e",
          'process.stdout.write(await Bun.stdin.text()); process.stderr.write("diagnostic"); process.exitCode = 19;',
        ],
        stdin: input,
        capture: true,
      }),
    ).pipe(Effect.provide(Process.layer)),
  );
  // Then
  expect(result).toEqual({ exitCode: 19, stdout: input, stderr: "diagnostic" });
});

test("private shell nonzero errors preserve the exit and canonically redacted stderr", async () => {
  // Given
  const secret = "private-nonzero-secret";
  const redaction = makeRedactionService();
  // When
  const error = await Effect.runPromise(
    Shell.withShellRedactionTokens(
      [secret],
      Effect.flatMap(ShellRunner, (runner) =>
        runner.run(`printf ${secret} 1>&2; exit 23`, { capture: true }),
      ),
    ).pipe(Effect.provide(shellLayer), Effect.provideService(RedactionService, redaction), Effect.flip),
  );
  // Then
  expect(error.exitCode).toBe(23);
  expect(error.stderr).toBe("[redacted]");
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(error.cause).toBeUndefined();
});

test("private shell spawn failure does not fabricate a process exit", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-private-spawn-"));
  try {
    // When
    const error = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (runner) =>
        runner.run("echo private", { cwd: join(root, "missing"), capture: true }),
      ).pipe(Effect.provide(shellLayer), Effect.flip),
    );
    // Then
    expect(error).toBeInstanceOf(ShellExecError);
    expect(error.exitCode).toBeUndefined();
    expect(error.cause).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["run", "streamWithExit"] as const)("accepts exact binary limit in private %s", async (method) => {
  // Given
  const options = {
    cmd: process.execPath,
    args: ["-e", `process.stdout.write(new Uint8Array(${limit}).fill(255));`],
    capture: true,
  };
  // When
  const result = await Effect.runPromise(
    Effect.flatMap(ProcessRunner, (runner) =>
      method === "run"
        ? runner.run(options).pipe(Effect.map((result) => ({ text: result.stdout, bytes: Buffer.alloc(0) })))
        : runner.streamWithExit(options).pipe(
            Stream.runCollect,
            Effect.map((events) => ({
              text: "",
              bytes: Buffer.concat(events.flatMap((event) => ("kind" in event ? [event.chunk] : []))),
            })),
          ),
    ).pipe(Effect.provide(Process.layer)),
  );
  // Then
  expect(result).toEqual(
    method === "run"
      ? { text: "�".repeat(limit), bytes: Buffer.alloc(0) }
      : { text: "", bytes: Buffer.alloc(limit, 255) },
  );
});

test.each(["run", "stream", "streamWithExit"] as const)("rejects private inheritance: %s", async (method) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-private-inherit-"));
  const marker = join(root, "spawned");
  try {
    const options = {
      cmd: process.execPath,
      args: ["-e", `await Bun.write(${JSON.stringify(marker)}, "spawned")`],
      capture: true,
      inheritOutput: true,
    };
    // When
    const error = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (runner) =>
        method === "run"
          ? runner.run(options).pipe(Effect.asVoid)
          : runner[method](options).pipe(Stream.runDrain),
      ).pipe(Effect.provide(Process.layer), Effect.flip),
    );
    // Then
    expect(error).toBeInstanceOf(ProcessExecError);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["process", "command", "script"] as const)("private %s suppresses observation", async (mode) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-private-quiet-"));
  const path = join(root, "private.bun.sh");
  const frames: StreamFrameSinkFrame[] = [];
  const events: LandoEvent[] = [];
  const command = "printf private; printf diagnostic 1>&2";
  const redaction = makeRedactionService();
  await Effect.runPromise(redaction.registerValues(["private", "diagnostic"]));
  try {
    await writeFile(path, command);
    // When
    const shellRun = Effect.flatMap(ShellRunner, (runner) =>
      mode === "command" ? runner.run(command, { capture: true }) : runner.runScript(path, { capture: true }),
    ).pipe(Effect.provide(shellLayer));
    const execute: Effect.Effect<ProcessResult, ProcessExecError | ProcessTimeoutError | ShellExecError> =
      mode === "process"
        ? processRun('process.stdout.write("private"); process.stderr.write("diagnostic");')
        : shellRun;
    const result = await Effect.runPromise(
      execute.pipe(
        Effect.provideService(RedactionService, redaction),
        Effect.provideService(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              frames.push(frame);
            }),
        }),
        Effect.provideService(
          EventService,
          EventService.of({
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            subscribe: () => Stream.empty,
            subscribeQueue: Queue.unbounded<never>(),
            waitFor: () => Effect.never,
            waitForAny: () => Effect.never,
            query: () => Effect.succeed([]),
          }),
        ),
      ),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "private", stderr: "diagnostic" });
    expect(frames).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["command", "script"] as const)("rejects private binary %s overflow", async (mode) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-private-binary-"));
  const path = join(root, "binary.bun.sh");
  const command = `bun -e 'process.stdout.write(new Uint8Array(${limit + 1}).fill(255))'`;
  try {
    await writeFile(path, command);
    // When
    const error = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (runner) =>
        mode === "command"
          ? runner.run(command, { capture: true })
          : runner.runScript(path, { capture: true }),
      ).pipe(Effect.provide(shellLayer), Effect.flip),
    );
    // Then
    expect(error).toBeInstanceOf(ShellExecError);
    expect(error.exitCode).toBeUndefined();
    expect(error.stdout).toBeUndefined();
    expect(error.stderr).toBeUndefined();
    expect(error.cause).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
