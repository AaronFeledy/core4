import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { annotateFailureRole, failureDefectCause, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import {
  CONTROL_STDOUT_LIMIT,
  type CommandOutputFailure,
  captureCommandOutput,
  commandOutputStream,
} from "../src/command-output.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const stderr = (value: string): ExecChunk => ({ kind: "stderr", chunk: bytes(value) });
const stdout = (value: string): ExecChunk => ({ kind: "stdout", chunk: bytes(value) });
const failure = (evidence: CommandOutputFailure) => ({ _tag: "SafeOutput", ...evidence });
const captured = <E, R>(source: Stream.Stream<ExecChunk, E, R>, options = {}) =>
  captureCommandOutput(source, { failure, ...options });
const failed = async <A>(effect: Effect.Effect<A, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("Expected failed command");
  return failureOutcomeFromCause(exit.cause);
};

test.each([
  ["empty", Stream.empty],
  ["output without terminal", Stream.make(stdout("private"))],
  ["duplicate terminal", Stream.make({ exitCode: 0 }, { exitCode: 0 })],
  ["stdout after terminal", Stream.make({ exitCode: 0 }, stdout("private"))],
  ["stderr after terminal", Stream.make({ exitCode: 0 }, stderr("private"))],
  ["invalid terminal", Stream.make({ exitCode: Number.NaN })],
  ["fractional terminal", Stream.make({ exitCode: 0.5 })],
  ["infinite terminal", Stream.make({ exitCode: Number.POSITIVE_INFINITY })],
] as const)("rejects protocol violation: %s", async (_name, source) => {
  expect((await failed(captured(source))).error).toMatchObject({ reason: "protocol" });
});

test("drains after nonzero terminal and gives protocol or provider failure precedence", async () => {
  let drained = false;
  const terminal = Stream.make({ exitCode: 7 });
  const after = Stream.fromEffect(
    Effect.sync(() => {
      drained = true;
      return stdout("late secret");
    }),
  );
  const protocol = await failed(captured(Stream.concat(terminal, after)));
  expect(drained).toBe(true);
  expect(protocol.error).toMatchObject({ reason: "protocol", exitCode: 7 });
  const provider = await failed(
    captured(Stream.concat(terminal, Stream.fail({ details: { exitCode: 0 }, message: "PRIVATE" }))),
  );
  expect(provider.error).toMatchObject({ reason: "provider", exitCode: 7 });
  expect(JSON.stringify(provider)).not.toContain("PRIVATE");
});

test("does not infer exit codes from provider errors and keeps timeout distinct", async () => {
  expect(
    (await failed(captured(Stream.fail({ details: { exitCode: 7 }, stdout: "PRIVATE" })))).error,
  ).toMatchObject({ reason: "provider", exitCode: undefined });
  const timeout = new ProcessTimeoutError({
    message: "PRIVATE",
    cmd: "PRIVATE",
    elapsedMs: 1,
    remediation: "Retry fixture.",
  });
  expect((await failed(captured(Stream.fail(timeout)))).error).toMatchObject({
    reason: "timeout",
    exitCode: undefined,
  });
});

test("bounds control stdout, drains overflow, and prioritizes observed failure", async () => {
  let terminalRead = false;
  const source = (exitCode: number) =>
    Stream.concat(
      Stream.make(stdout("0"), { kind: "stdout" as const, chunk: new Uint8Array(CONTROL_STDOUT_LIMIT) }),
      Stream.fromEffect(
        Effect.sync(() => {
          terminalRead = true;
          return { exitCode };
        }),
      ),
    );
  expect((await failed(captured(source(0)))).error).toMatchObject({ reason: "stdout-limit", exitCode: 0 });
  expect(terminalRead).toBe(true);
  expect((await failed(captured(source(7)))).error).toMatchObject({ reason: "exit", exitCode: 7 });
  const exact = await Effect.runPromise(
    captured(
      Stream.make({ kind: "stdout", chunk: new Uint8Array(CONTROL_STDOUT_LIMIT).fill(65) }, { exitCode: 0 }),
    ),
  );
  expect(exact.stdout.length).toBe(CONTROL_STDOUT_LIMIT);
  const discard = await Effect.runPromise(captured(source(0), { stdout: "discard" }));
  expect(discard.stdout).toBe("");
});

test("forwards exact binary payload arrays and decodes only bounded control stdout", async () => {
  const payload = new Uint8Array([0, 255, 195, 169, 10, 120]);
  const output = await Effect.runPromise(
    commandOutputStream(Stream.make({ kind: "stdout", chunk: payload }, { exitCode: 0 }), {
      failure,
      authoritativeTokens: ["x"],
    }).pipe(Stream.runCollect),
  );
  expect(Array.from(output)[0]).toBe(payload);
  const encoded = bytes("é界");
  const source = Stream.fromIterable(
    [...encoded].map((byte): ExecChunk => ({ kind: "stdout", chunk: new Uint8Array([byte]) })),
  );
  expect(
    (await Effect.runPromise(captured(Stream.concat(source, Stream.make({ exitCode: 0 }))))).stdout,
  ).toBe("é界");
});

test("redacts split byte secrets and sees late operation registrations", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const redaction = yield* RedactionService;
      const encoded = bytes("é sëcret-token lando\nlate-secret\n");
      const source = Stream.concat(
        Stream.fromIterable(
          [...encoded].map((byte): ExecChunk => ({ kind: "stderr", chunk: new Uint8Array([byte]) })),
        ),
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* redaction.registerValues(["late-secret"]);
            return { exitCode: 7 };
          }),
        ),
      );
      return yield* captured(source, { authoritativeTokens: ["sëcret-token", "lando"] }).pipe(Effect.result);
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
  if (result._tag !== "Failure") throw new Error("Expected failure");
  expect(result.failure.stderrTail).toBe("é [redacted] [redacted]\n[redacted]\n");
});

test.each([0, 7])(
  "sanitizes real producer finalizers with their cleanup role (exit=%s)",
  async (exitCode) => {
    let closed = 0;
    const source = Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            closed += 1;
          }).pipe(
            Effect.andThen(
              Effect.failCause(
                failureDefectCause(
                  annotateFailureRole(
                    Cause.fail({ _tag: "Cleanup", message: "PRIVATE", cause: "PRIVATE" }),
                    "cleanup",
                  ),
                ),
              ),
            ),
          ),
        );
        return Stream.make(stderr("known diagnostic"), { exitCode });
      }),
    );
    const outcome = await failed(captured(source));
    expect(closed).toBe(1);
    if (exitCode === 7) {
      expect(outcome.error).toMatchObject({ reason: "exit", exitCode: 7, stderrTail: "known diagnostic" });
      expect(outcome.additionalErrors).toEqual([
        { role: "cleanup", error: expect.objectContaining({ reason: "provider", exitCode: 7 }) },
      ]);
    } else {
      expect(outcome.error).toMatchObject({ reason: "provider", exitCode: 0, role: "cleanup" });
    }
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
  },
);

test("preserves interrupts and finalizes on cancellation and downstream early completion", async () => {
  let closed = 0;
  const source = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          closed += 1;
        }),
      );
      return Stream.concat(Stream.make(stdout("first")), Stream.fromEffect(Effect.never));
    }),
  );
  await Effect.runPromise(commandOutputStream(source, { failure }).pipe(Stream.take(1), Stream.runDrain));
  expect(closed).toBe(1);
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(captured(source));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(closed).toBe(2);
});

test("huge lazy diagnostics retain bounded memory and a single huge chunk is suppressed", async () => {
  Bun.gc(true);
  const memory = () => {
    const usage = process.memoryUsage();
    return usage.arrayBuffers + usage.heapUsed;
  };
  const before = memory();
  let peak = before;
  const source = Stream.fromIterable(
    {
      *[Symbol.iterator](): Generator<ExecChunk> {
        for (let index = 0; index < 384; index += 1) {
          const chunk = new Uint8Array(1024 * 1024).fill(65);
          if (index % 32 === 0) {
            Bun.gc(true);
            peak = Math.max(peak, memory());
          }
          yield { kind: "stderr", chunk };
          yield { kind: "stdout", chunk };
        }
        yield { exitCode: 7 };
      },
    },
    { chunkSize: 1 },
  );
  const result = await failed(captured(source, { stdout: "discard" }));
  expect(result.error).toMatchObject({ stderrTail: "[diagnostic truncated]", exitCode: 7 });
  expect(peak - before).toBeLessThan(96 * 1024 * 1024);
  const huge = await failed(
    captured(Stream.make({ kind: "stderr", chunk: new Uint8Array(16 * 1024 * 1024) }, { exitCode: 7 })),
  );
  expect(huge.error).toMatchObject({ stderrTail: "[diagnostic truncated]" });
});
