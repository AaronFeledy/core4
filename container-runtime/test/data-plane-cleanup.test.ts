import { describe, expect, test } from "bun:test";
import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProviderUnavailableError, VolumeOperationError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { echoHelperPull } from "./helper-pull-support.ts";

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

type FailedCreateMode = "buffered" | "streamed" | "snapshot";
type FailedCreateKind = { readonly kind: "http"; readonly status: number } | { readonly kind: "transport" };
type FailedCleanupKind =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "transport" }
  | { readonly kind: "defect"; readonly defect: unknown }
  | { readonly kind: "cause"; readonly cause: Cause.Cause<ProviderError> };

const publicModes = ["buffered", "streamed"] as const;
const acquireModes = ["buffered", "streamed", "snapshot"] as const;
const snapshotSpec = { volume: { app: AppId.make("app"), store: "data" }, snapshotId: "snap" } as const;

const createQueryName = (requests: ReadonlyArray<{ method: string; path: string }>): string => {
  const create = requests.find(
    (request) => request.method === "POST" && request.path.startsWith("/containers/create?name="),
  );
  if (create === undefined) throw new Error("missing create request");
  return decodeURIComponent(create.path.slice("/containers/create?name=".length));
};

const expectRemovedOnce = (requests: ReadonlyArray<{ method: string; path: string }>) => {
  const name = createQueryName(requests);
  expect(deletes(requests)).toEqual([
    { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true&v=true` },
  ]);
  return name;
};

const invokeFailedCreate = (provider: ReturnType<typeof makeProviderDataPlane>, mode: FailedCreateMode) => {
  if (mode === "buffered") return Effect.scoped(provider.run(spec).pipe(Effect.asVoid));
  if (mode === "streamed") return Effect.scoped(provider.runStream(spec).pipe(Stream.runDrain));
  return Effect.scoped(provider.snapshotVolume(snapshotSpec).pipe(Effect.asVoid));
};

const failedCreatePlane = (
  requests: Array<{ method: string; path: string }>,
  script: {
    readonly create: FailedCreateKind | { readonly kind: "defect"; readonly defect: unknown };
    readonly cleanup: FailedCleanupKind;
    readonly created?: Set<string>;
  },
) => {
  const transport = new ProviderUnavailableError({
    providerId: "test",
    operation: "transport",
    message: "socket down",
    remediation: "retry",
  });
  const api: DataPlaneApiClient = {
    request: (request) => {
      requests.push({ method: request.method, path: request.path });
      if (request.method === "DELETE") {
        const name = decodeURIComponent(request.path.slice("/containers/".length).split("?")[0] ?? "");
        script.created?.delete(name);
        if (script.cleanup.kind === "transport") return Effect.fail(transport);
        if (script.cleanup.kind === "defect") return Effect.die(script.cleanup.defect);
        if (script.cleanup.kind === "cause") return Effect.failCause(script.cleanup.cause);
        return Effect.succeed({ status: script.cleanup.status, body: "" });
      }
      if (request.path.startsWith("/containers/create?name=")) {
        const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
        script.created?.add(name);
        if (script.create.kind === "transport") return Effect.fail(transport);
        if (script.create.kind === "defect") return Effect.die(script.create.defect);
        if (script.create.status === 409) script.created?.delete(name);
        return Effect.succeed({ status: script.create.status, body: "create failed" });
      }
      return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
    },
    stream: () => Stream.empty,
  };
  return makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "native" },
    redactor: scriptRedactor((value) => value),
    pullHelperImage: echoHelperPull(),
  });
};

describe("failed-create compensation", () => {
  test.each(acquireModes.flatMap((mode) => [204, 404].map((status) => [mode, status] as const)))(
    "%s removes the create-query name once when create returns 500 and DELETE returns %s",
    async (mode, status) => {
      const requests: Array<{ method: string; path: string }> = [];
      const created = new Set<string>();
      const exit = await Effect.runPromiseExit(
        invokeFailedCreate(
          failedCreatePlane(requests, {
            create: { kind: "http", status: 500 },
            cleanup: { kind: "status", status },
            created,
          }),
          mode,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const name = expectRemovedOnce(requests);
      expect(created.has(name)).toBe(false);
      const outcome = failureOutcomeFromCause(exit.cause);
      expect(outcome.additionalErrors).toEqual([]);
      if (mode === "snapshot") {
        expect(outcome.error).toMatchObject({
          _tag: "VolumeOperationError",
          operation: "snapshotVolume",
          message: "Provider volume snapshot failed.",
          cause: {
            _tag: "VolumeOperationError",
            operation: "run.create",
            message: "Provider data-plane API returned HTTP 500.",
          },
        });
        return;
      }
      expect(outcome.error).toMatchObject({
        _tag: "VolumeOperationError",
        operation: "run.create",
        message: "Provider data-plane API returned HTTP 500.",
      });
      expect(roles(exit.cause)).toEqual(["unscoped"]);
    },
  );

  test.each(acquireModes)("%s leaves a 409 name conflict untouched", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const created = new Set<string>(["foreign-helper"]);
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "http", status: 409 },
          cleanup: { kind: "status", status: 204 },
          created,
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(deletes(requests)).toEqual([]);
    expect(created.has("foreign-helper")).toBe(true);
    expect(created.has(createQueryName(requests))).toBe(false);
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.additionalErrors).toEqual([]);
    const createError =
      mode === "snapshot" && outcome.error instanceof VolumeOperationError
        ? outcome.error.cause
        : outcome.error;
    expect(createError).toMatchObject({
      _tag: "VolumeOperationError",
      operation: "run.create",
      message: "Provider data-plane API returned HTTP 409.",
    });
  });

  test.each(acquireModes)("%s compensates a typed create transport failure exactly once", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "transport" },
          cleanup: { kind: "status", status: 204 },
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expectRemovedOnce(requests);
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.additionalErrors).toEqual([]);
    const createError =
      mode === "snapshot" && outcome.error instanceof VolumeOperationError
        ? outcome.error.cause
        : outcome.error;
    expect(createError).toMatchObject({
      _tag: "VolumeOperationError",
      operation: "run.create",
      message: "Provider API request failed.",
      cause: { _tag: "ProviderUnavailableError", message: "socket down" },
    });
  });

  test.each(publicModes)("%s does not DELETE when create fails and remove is false", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        mode === "buffered"
          ? failedCreatePlane(requests, {
              create: { kind: "http", status: 500 },
              cleanup: { kind: "status", status: 204 },
            }).run({ ...spec, remove: false })
          : failedCreatePlane(requests, {
              create: { kind: "http", status: 500 },
              cleanup: { kind: "status", status: 204 },
            })
              .runStream({ ...spec, remove: false })
              .pipe(Stream.runDrain),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(deletes(requests)).toEqual([]);
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "VolumeOperationError", operation: "run.create" },
      additionalErrors: [],
    });
  });

  test.each(publicModes)("%s keeps create HTTP 500 primary when DELETE returns 500", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "http", status: 500 },
          cleanup: { kind: "status", status: 500 },
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expectRemovedOnce(requests);
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: {
        _tag: "VolumeOperationError",
        operation: "run.create",
        message: "Provider data-plane API returned HTTP 500.",
      },
      additionalErrors: [
        { role: "cleanup", error: { _tag: "ProviderUnavailableError", operation: "run.create.remove" } },
      ],
    });
    expect(roles(exit.cause)).toEqual(["unscoped", "cleanup"]);
  });

  test.each(publicModes)("%s keeps create HTTP 500 primary when DELETE transport fails", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "http", status: 500 },
          cleanup: { kind: "transport" },
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expectRemovedOnce(requests);
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "VolumeOperationError", operation: "run.create" },
      additionalErrors: [{ role: "cleanup", error: { message: "socket down" } }],
    });
  });

  test.each(publicModes)("%s re-fails the original create defect when DELETE returns 404", async (mode) => {
    const defect = { tag: "create-defect" };
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "defect", defect },
          cleanup: { kind: "status", status: 404 },
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expectRemovedOnce(requests);
    expect(Cause.hasFails(exit.cause)).toBe(false);
    expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
    expect(failureOutcomeFromCause(exit.cause).additionalErrors).toEqual([]);
  });

  test.each(publicModes)("%s retains create error and appends annotated cleanup defects", async (mode) => {
    const cleanupError = new ProviderUnavailableError({
      providerId: "test",
      operation: "cleanup.original",
      message: "cleanup failed",
      remediation: "retry",
    });
    const defect = { tag: "cleanup-defect" };
    const requests: Array<{ method: string; path: string }> = [];
    const exit = await Effect.runPromiseExit(
      invokeFailedCreate(
        failedCreatePlane(requests, {
          create: { kind: "http", status: 500 },
          cleanup: {
            kind: "cause",
            cause: Cause.fromReasons([
              Cause.makeFailReason(cleanupError).annotate(Context.make(FailureRoleAnnotation, "rollback")),
              Cause.makeDieReason(defect),
            ]),
          },
        }),
        mode,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expectRemovedOnce(requests);
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "VolumeOperationError", operation: "run.create" },
      additionalErrors: [
        { role: "rollback", error: cleanupError },
        { role: "cleanup", error: defect },
      ],
    });
    expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
    expect(roles(exit.cause)).toEqual(["unscoped", "rollback", "cleanup"]);
  });

  test.each(publicModes)(
    "%s cancels a pending create that later succeeds and still removes",
    async (mode) => {
      const requests: Array<{ method: string; path: string }> = [];
      const pending = await Effect.runPromise(Deferred.make<void>());
      const complete = await Effect.runPromise(
        Deferred.make<{ readonly status: number; readonly body: string }>(),
      );
      const provider = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "none" },
        redactor: scriptRedactor((value) => value),
        api: {
          request: (request) => {
            requests.push({ method: request.method, path: request.path });
            if (request.path.startsWith("/containers/create?name=")) {
              return Deferred.succeed(pending, undefined).pipe(Effect.andThen(Deferred.await(complete)));
            }
            if (request.method === "DELETE") return Effect.succeed({ status: 204, body: "" });
            if (request.path.endsWith("/wait")) return Effect.never;
            if (request.path.endsWith("/json")) {
              return Effect.succeed({ status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) });
            }
            return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
          },
          stream: () => Stream.empty,
        },
      });
      const inner = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(invokeFailedCreate(provider, mode));
          yield* Deferred.await(pending);
          yield* Effect.forkChild(Fiber.interrupt(fiber));
          yield* Deferred.succeed(complete, { status: 201, body: "{}" });
          return yield* Fiber.await(fiber);
        }),
      );
      expect(Exit.isFailure(inner)).toBe(true);
      if (!Exit.isFailure(inner)) return;
      expect(Cause.hasInterrupts(inner.cause)).toBe(true);
      expectRemovedOnce(requests);
    },
  );

  test.each(publicModes)("%s cancels a pending create that later fails and still removes", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    const pending = await Effect.runPromise(Deferred.make<void>());
    const complete = await Effect.runPromise(
      Deferred.make<{ readonly status: number; readonly body: string }>(),
    );
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "none" },
      redactor: scriptRedactor((value) => value),
      api: {
        request: (request) => {
          requests.push({ method: request.method, path: request.path });
          if (request.path.startsWith("/containers/create?name=")) {
            return Deferred.succeed(pending, undefined).pipe(Effect.andThen(Deferred.await(complete)));
          }
          if (request.method === "DELETE") return Effect.succeed({ status: 204, body: "" });
          return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
        },
        stream: () => Stream.empty,
      },
    });
    const inner = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(invokeFailedCreate(provider, mode));
        yield* Deferred.await(pending);
        yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.succeed(complete, { status: 500, body: "create failed" });
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(inner)).toBe(true);
    if (!Exit.isFailure(inner)) return;
    expectRemovedOnce(requests);
    expect(failureOutcomeFromCause(inner.cause).error).toMatchObject({
      _tag: "VolumeOperationError",
      operation: "run.create",
      message: "Provider data-plane API returned HTTP 500.",
    });
  });
});
