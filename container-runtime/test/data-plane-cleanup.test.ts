import { describe, expect, test } from "bun:test";
import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const multiplexedStderr = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame[0] = 2;
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
};

type Cleanup =
  | { readonly kind: "status"; readonly status: number; readonly body?: string }
  | { readonly kind: "transport" };

/** A non-string redaction result means the value could not be made safe, so it is fully masked. */
const scriptRedactor = (redact: (value: unknown) => unknown): Redactor => ({
  redactString: (value) => {
    const redacted = redact(value);
    return typeof redacted === "string" ? redacted : "[redacted]";
  },
  redactValue: redact,
});

interface Script {
  readonly cleanup: Cleanup;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stderrChunks?: readonly Uint8Array[];
  readonly failStart?: boolean;
  readonly hangWait?: boolean;
  readonly redact?: (value: unknown) => unknown;
}

const recordedPlane = (
  requests: Array<{ method: string; path: string }>,
  script: Script,
  waiting?: Deferred.Deferred<void>,
) => {
  const api: DataPlaneApiClient = {
    request: (request) => {
      requests.push({ method: request.method, path: request.path });
      if (request.method === "DELETE") {
        return script.cleanup.kind === "transport"
          ? Effect.fail(
              new ProviderUnavailableError({
                providerId: "test",
                operation: "transport",
                message: "socket down",
                remediation: "retry",
              }),
            )
          : Effect.succeed({ status: script.cleanup.status, body: script.cleanup.body ?? "" });
      }
      if (request.path.endsWith("/start") && script.failStart === true) {
        return Effect.succeed({ status: 500, body: "start failed" });
      }
      if (request.path.endsWith("/wait") && script.hangWait === true && waiting !== undefined) {
        return Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never));
      }
      if (request.path.endsWith("/json")) {
        return Effect.succeed({
          status: 200,
          body: JSON.stringify({ State: { ExitCode: script.exitCode ?? 0 } }),
        });
      }
      return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
    },
    stream: () =>
      Stream.fromIterable(
        (script.stderrChunks ?? (script.stderr === undefined ? [] : [bytes(script.stderr)])).map(
          multiplexedStderr,
        ),
      ),
  };
  return makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "none" },
    redactor: scriptRedactor(script.redact ?? ((value) => value)),
  });
};

const deletes = (requests: ReadonlyArray<{ method: string; path: string }>) =>
  requests.filter((request) => request.method === "DELETE");

const spec = { image: "alpine:3.20", command: ["true"], remove: true } as const;

const roles = (cause: Cause.Cause<unknown>): ReadonlyArray<string> =>
  cause.reasons.map((reason) => {
    if (Cause.isInterruptReason(reason)) return "interrupt";
    return Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) ?? "unscoped";
  });

const boundarySecret = `boundary-credential-${"z".repeat(64)}-end`;
const diagnosticError = Schema.Struct({
  details: Schema.Struct({ exitCode: Schema.Number, stderrTail: Schema.String }),
});
const redactSecrets = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.replaceAll("super-secret-token", "[redacted]").replaceAll(boundarySecret, "[redacted]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry)]));
  }
  return value;
};

describe("ephemeral cleanup", () => {
  test.each([204, 404])("buffered success stays successful when cleanup returns %s", async (status) => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(recordedPlane(requests, { cleanup: { kind: "status", status } }).run(spec)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(0);
    expect(deletes(requests)).toHaveLength(1);
    expect(deletes(requests)[0]?.path).toContain("?force=true&v=true");
  });

  test("buffered success fails visibly when cleanup returns 500", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, {
          cleanup: { kind: "status", status: 500, body: "super-secret-token" },
          redact: redactSecrets,
        }).run(spec),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.error).toMatchObject({ _tag: "ProviderUnavailableError", operation: "run.remove" });
    expect(roles(exit.cause)).toEqual(["cleanup"]);
    expect(JSON.stringify(outcome)).not.toContain("super-secret-token");
    expect(deletes(requests)).toHaveLength(1);
  });

  test("buffered success fails visibly when cleanup transport fails", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(recordedPlane(requests, { cleanup: { kind: "transport" } }).run(spec)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({
      _tag: "ProviderUnavailableError",
      message: "socket down",
    });
    expect(roles(exit.cause)).toEqual(["cleanup"]);
  });

  test("buffered start failure stays primary when cleanup returns 500", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "status", status: 500 }, failStart: true }).run(spec),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "VolumeOperationError", operation: "run", message: "Provider ephemeral run failed." },
      additionalErrors: [
        { role: "cleanup", error: { _tag: "ProviderUnavailableError", operation: "run.remove" } },
      ],
    });
    expect(deletes(requests)).toHaveLength(1);
  });

  test("buffered start failure has no cleanup error when removal returns 204", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "status", status: 204 }, failStart: true }).run(spec),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.error).toMatchObject({
      _tag: "VolumeOperationError",
      operation: "run",
      message: "Provider ephemeral run failed.",
    });
    expect(outcome.additionalErrors).toEqual([]);
  });

  test("buffered nonzero exit stays a result when cleanup succeeds", async () => {
    const stderr = `super-secret-token ${"kept-".repeat(2_000)}end`;
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, {
          cleanup: { kind: "status", status: 204 },
          exitCode: 3,
          stderr,
          redact: redactSecrets,
        }).run(spec),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.exitCode).toBe(3);
      expect(exit.value.stderr).toBe(stderr);
    }
  });

  test("buffered nonzero exit keeps bounded redacted diagnostics when cleanup fails", async () => {
    const stderr = `safe super-secret-token ${"x".repeat(20_000)}`;
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, {
          cleanup: { kind: "status", status: 500 },
          exitCode: 9,
          stderr,
          redact: redactSecrets,
        }).run(spec),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.error).toMatchObject({
      _tag: "VolumeOperationError",
      operation: "run",
      details: { exitCode: 9 },
    });
    const { details } = Schema.decodeUnknownSync(diagnosticError)(outcome.error);
    expect(details.stderrTail).toContain("safe [redacted]");
    expect(details.stderrTail).toContain("[diagnostic truncated]");
    expect(outcome.additionalErrors).toEqual([
      {
        role: "cleanup",
        error: expect.objectContaining({ _tag: "ProviderUnavailableError", operation: "run.remove" }),
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("super-secret-token");
  });

  test("buffered interruption still removes the container", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const waiting = await Effect.runPromise(Deferred.make<void>());
    const provider = recordedPlane(
      requests,
      { cleanup: { kind: "status", status: 204 }, hangWait: true },
      waiting,
    );
    const inner = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(provider.run(spec)));
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(inner)).toBe(true);
    if (Exit.isFailure(inner)) expect(Cause.hasInterrupts(inner.cause)).toBe(true);
    expect(deletes(requests)).toHaveLength(1);
  });

  test("buffered interruption keeps the interrupt when cleanup fails", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const waiting = await Effect.runPromise(Deferred.make<void>());
    const provider = recordedPlane(
      requests,
      { cleanup: { kind: "status", status: 500 }, hangWait: true },
      waiting,
    );
    const inner = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(provider.run(spec)));
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(inner)).toBe(true);
    if (!Exit.isFailure(inner)) return;
    expect(Cause.hasInterrupts(inner.cause)).toBe(true);
    expect(roles(inner.cause)).toContain("interrupt");
    expect(roles(inner.cause)).toContain("cleanup");
    expect(deletes(requests)).toHaveLength(1);
  });

  test("skipping removal does not call the engine", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "status", status: 500 } }).run({ ...spec, remove: false }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(deletes(requests)).toEqual([]);
  });

  test.each([204, 404])("streamed success stays successful when cleanup returns %s", async (status) => {
    const requests: Array<{ method: string; path: string }> = [];
    const chunks = await Effect.runPromise(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "status", status }, exitCode: 0 })
          .runStream(spec)
          .pipe(Stream.runCollect),
      ),
    );
    expect(Array.from(chunks)).toEqual([{ exitCode: 0 }]);
    expect(deletes(requests)).toHaveLength(1);
  });

  test("streamed success fails visibly when cleanup returns 500", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "status", status: 500 } })
          .runStream(spec)
          .pipe(Stream.runCollect),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "runStream.remove",
    });
    expect(roles(exit.cause)).toContain("cleanup");
  });

  test("streamed start failure stays primary when cleanup transport fails", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, { cleanup: { kind: "transport" }, failStart: true })
          .runStream(spec)
          .pipe(Stream.runCollect),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "VolumeOperationError", operation: "runStream" },
      additionalErrors: [{ role: "cleanup", error: { message: "socket down" } }],
    });
  });

  test("streamed nonzero exit stays in the chunk when cleanup succeeds", async () => {
    const stderr = `super-secret-token ${"stream-".repeat(2_000)}end`;
    const requests: Array<{ method: string; path: string }> = [];
    const chunks = await Effect.runPromise(
      Effect.scoped(
        recordedPlane(requests, {
          cleanup: { kind: "status", status: 204 },
          exitCode: 4,
          stderr,
          redact: redactSecrets,
        })
          .runStream(spec)
          .pipe(Stream.runCollect),
      ),
    );
    expect(Array.from(chunks)).toEqual([{ kind: "stderr", chunk: bytes(stderr) }, { exitCode: 4 }]);
  });

  test("streamed nonzero exit keeps diagnostics when cleanup returns 500", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        recordedPlane(requests, {
          cleanup: { kind: "status", status: 500 },
          exitCode: 4,
          stderrChunks: [bytes("safe super-sec"), bytes("ret-token stream failure")],
          redact: redactSecrets,
        })
          .runStream(spec)
          .pipe(Stream.runCollect),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: {
        _tag: "VolumeOperationError",
        operation: "runStream",
        details: { exitCode: 4, stderrTail: "safe [redacted] stream failure" },
      },
      additionalErrors: [{ role: "cleanup", error: { operation: "runStream.remove" } }],
    });
  });

  for (const mode of ["buffered", "streamed"] as const) {
    test.each([
      {
        name: "credential crossing the clipping boundary",
        stderr: `${"x".repeat(8 * 1024 - 40)}${boundarySecret}${" trailing evidence".repeat(10)}`,
        retained: "[redacted]",
      },
      { name: "multibyte UTF-8 evidence", stderr: `safe ${"😀é".repeat(2_000)}`, retained: "safe 😀é" },
    ])(`${mode} redacts before byte clipping: $name`, async ({ stderr, retained }) => {
      // Given complete stderr, including credentials spanning the final evidence limit.
      const payload = bytes(stderr);
      const provider = recordedPlane([], {
        cleanup: { kind: "status", status: 500 },
        exitCode: 7,
        stderrChunks: [payload.subarray(0, 8 * 1024), payload.subarray(8 * 1024)],
        redact: redactSecrets,
      });
      // When a nonzero command also fails cleanup.
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "buffered" ? provider.run(spec) : provider.runStream(spec).pipe(Stream.runDrain),
        ),
      );
      // Then evidence is useful, redacted, and bounded in bytes without broken codepoints.
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = failureOutcomeFromCause(exit.cause).error;
      const { details } = Schema.decodeUnknownSync(diagnosticError)(error);
      expect(details.stderrTail).toContain(retained);
      expect(details.stderrTail).toContain("[diagnostic truncated]");
      expect(bytes(details.stderrTail).length).toBeLessThanOrEqual(8 * 1024);
      expect(details.stderrTail).not.toContain("�");
      expect(JSON.stringify(error)).not.toContain("boundary-");
      expect(roles(exit.cause)).toEqual(["unscoped", "cleanup"]);
    });
  }

  test("streamed diagnostics suppress all context when the byte budget overflows", async () => {
    // Given a retained canary and multibyte context exceeding the byte budget.
    const stderrChunks = [
      bytes("context-canary super-secret-token "),
      bytes("😀".repeat(17_000)),
      bytes(" super-secret-token end"),
    ];
    const provider = recordedPlane([], {
      cleanup: { kind: "status", status: 500 },
      exitCode: 8,
      stderrChunks,
      redact: redactSecrets,
    });
    const forwarded: Uint8Array[] = [];
    // When cleanup fails after all bytes were forwarded.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        provider.runStream(spec).pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              if ("chunk" in chunk) forwarded.push(chunk.chunk);
            }),
          ),
          Stream.runDrain,
        ),
      ),
    );
    // Then no partial raw context survives, but output forwarding is unchanged.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = failureOutcomeFromCause(exit.cause).error;
    expect(error).toMatchObject({ details: { exitCode: 8, stderrTail: "[diagnostic truncated]" } });
    expect(forwarded).toEqual(stderrChunks);
  });

  test("cleanup API reasons fail closed when the redactor returns a non-string", async () => {
    // Given a provider redactor that suppresses strings with a non-string result.
    const provider = recordedPlane([], {
      cleanup: { kind: "status", status: 500, body: JSON.stringify({ message: "super-secret-token" }) },
      redact: () => undefined,
    });
    // When removal fails with a secret in the API reason.
    const exit = await Effect.runPromiseExit(Effect.scoped(provider.run(spec)));
    // Then the reason never falls back to raw text.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(JSON.stringify(failureOutcomeFromCause(exit.cause))).not.toContain("super-secret-token");
  });

  test("streamed interruption still removes the container and keeps the interrupt", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const waiting = await Effect.runPromise(Deferred.make<void>());
    const provider = recordedPlane(
      requests,
      { cleanup: { kind: "status", status: 500 }, hangWait: true },
      waiting,
    );
    const inner = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(provider.runStream(spec).pipe(Stream.runDrain)));
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(inner)).toBe(true);
    if (!Exit.isFailure(inner)) return;
    expect(Cause.hasInterrupts(inner.cause)).toBe(true);
    expect(roles(inner.cause)).toContain("cleanup");
    expect(deletes(requests)).toHaveLength(1);
  });
});
