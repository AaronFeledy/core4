import { expect, test } from "bun:test";
import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { makeRedactionService } from "@lando/redaction/service";
import { FailureRoleAnnotation, failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { FakeEngine } from "./support/fake-engine.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const spec = { image: "alpine:3.20", command: ["true"], remove: true } as const;
const outcomes = ["success", "failed-body", "nonzero", "interrupted"] as const;
const modes = ["buffered", "streamed"] as const;
type Outcome = (typeof outcomes)[number];
type Mode = (typeof modes)[number];

const cases = modes.flatMap((mode) =>
  outcomes.flatMap((outcome) =>
    ["passthrough", "canonical"].map((redaction) => [mode, outcome, redaction] as const),
  ),
);

const recordedPlane = (
  requests: Array<{ method: string; path: string }>,
  outcome: Outcome,
  gates: {
    readonly waiting: Deferred.Deferred<void>;
    readonly deleting: Deferred.Deferred<void>;
    readonly teardown: Promise<void>;
  },
  redactor: Redactor,
) => {
  const engine = new FakeEngine({ exitCode: outcome === "nonzero" ? 9 : 0 });
  for (const operation of [
    "container.create",
    "container.start",
    "container.wait",
    "container.inspect",
    "container.delete",
  ] as const) {
    engine.observers.set(operation, ({ method, path }) => requests.push({ method, path }));
  }
  engine.inject(
    "container.delete",
    Deferred.succeed(gates.deleting, undefined).pipe(
      Effect.andThen(Effect.promise(() => gates.teardown)),
      Effect.as({ status: 204, body: "" }),
    ),
  );
  if (outcome === "failed-body") engine.fail("container.start", { status: 500, body: "start failed" });
  if (outcome === "interrupted") engine.hang("container.wait", gates.waiting);
  return makeProviderDataPlane({
    providerId: "test",
    api: engine.api,
    capabilities: { volumeSnapshot: "none" },
    redactor,
  });
};

const roles = (cause: Cause.Cause<unknown>): ReadonlyArray<string> =>
  cause.reasons.map((reason) => {
    if (Cause.isInterruptReason(reason)) return "interrupt";
    return Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) ?? "unscoped";
  });

const cleanupErrors = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
  cause.reasons.flatMap((reason) => {
    if (Cause.isInterruptReason(reason)) return [];
    if (Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) !== "cleanup")
      return [];
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });

test.each(cases)(
  "%s %s bounds a DELETE that never finishes with %s redaction",
  async (mode: Mode, outcome: Outcome, redactionMode: string) => {
    const canonical = redactionMode === "canonical";
    const redaction = makeRedactionService();
    const redactor = canonical
      ? await Effect.runPromise(redaction.forProfile("secrets"))
      : passthroughRedactor;
    await Effect.runPromise(redaction.registerValues(["lando", "test", "truncated"]));
    const requests: Array<{ method: string; path: string }> = [];
    const teardown = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<{
      readonly elapsed: number;
      readonly exit: Exit.Exit<void, unknown>;
    }>();
    const root = Effect.runFork(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const deleting = yield* Deferred.make<void>();
        const provider = recordedPlane(
          requests,
          outcome,
          { waiting, deleting, teardown: teardown.promise },
          redactor,
        );
        const work =
          mode === "buffered"
            ? provider.run(spec).pipe(Effect.asVoid)
            : provider.runStream(spec).pipe(Stream.runDrain);
        const child = yield* Effect.forkChild(
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            const inner = yield* Effect.forkChild(Effect.scoped(work));
            if (outcome === "interrupted") {
              yield* Deferred.await(waiting);
              // Interrupt the work fiber, not this measurement fiber, so its Exit stays observable.
              yield* Fiber.interrupt(inner);
            }
            const exit = yield* Fiber.await(inner);
            return { elapsed: (yield* Clock.currentTimeMillis) - start, exit };
          }),
        );
        yield* Deferred.await(deleting);
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(child);
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.matchCause({
          onFailure: (cause) => {
            settled.reject(cause);
          },
          onSuccess: (value) => {
            settled.resolve(value);
          },
        }),
      ),
    );
    const watchdog = setTimeout(() => {
      settled.reject(new Error(`${mode} ${outcome} cleanup deadline did not settle`));
    }, 2000);
    try {
      const result = await settled.promise;
      const operation = mode === "buffered" ? "run" : "runStream";
      expect(result.elapsed).toBe(10_000);
      expect(requests.filter((request) => request.method === "DELETE")).toEqual([
        expect.objectContaining({ method: "DELETE", path: expect.stringContaining("?force=true&v=true") }),
      ]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      if (!Exit.isFailure(result.exit)) return;
      const projected = failureOutcomeFromCause(result.exit.cause);
      if (canonical) {
        for (const error of [projected.error, ...projected.additionalErrors.map(({ error }) => error)]) {
          const diagnostic = taggedErrorJson(error);
          for (const token of ["lando", "test", "truncated"])
            expect(JSON.stringify(diagnostic)).not.toContain(token);
        }
      }
      expect(cleanupErrors(result.exit.cause)).toEqual([
        expect.objectContaining({
          _tag: "ProviderUnavailableError",
          operation: `${operation}.remove`,
        }),
      ]);
      switch (outcome) {
        case "success":
          expect(projected.error).toBeInstanceOf(ProviderUnavailableError);
          expect(Cause.hasInterrupts(result.exit.cause)).toBe(false);
          expect(roles(result.exit.cause)).toContain("cleanup");
          return;
        case "failed-body":
          expect(projected.error).toMatchObject({
            _tag: "ProviderUnavailableError",
            operation: "run.start",
            details: { status: 500 },
          });
          expect(projected.additionalErrors).toEqual([
            {
              role: "cleanup",
              error: expect.objectContaining({
                _tag: "ProviderUnavailableError",
                operation: `${operation}.remove`,
              }),
            },
          ]);
          return;
        case "nonzero":
          expect(projected.error).toMatchObject({
            _tag: "ProviderInternalError",
            operation,
            details: { exitCode: 9 },
          });
          expect(projected.additionalErrors).toEqual([
            {
              role: "cleanup",
              error: expect.objectContaining({
                _tag: "ProviderUnavailableError",
                operation: `${operation}.remove`,
              }),
            },
          ]);
          return;
        case "interrupted":
          expect(Cause.hasInterrupts(result.exit.cause)).toBe(true);
          expect(roles(result.exit.cause)).toContain("interrupt");
          expect(roles(result.exit.cause)).toContain("cleanup");
          return;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    } finally {
      clearTimeout(watchdog);
      // Unblock a masked finalizer even if a regression removes the production deadline.
      teardown.resolve();
      await Effect.runPromise(Fiber.interrupt(root));
    }
  },
  5000,
);

const createFailures = ["http", "transport"] as const;
const failedCreateCases = modes.flatMap((mode) => createFailures.map((create) => [mode, create] as const));

test.each(failedCreateCases)(
  "%s bounds a DELETE after failed create (%s) under masked acquisition",
  async (mode: Mode, create: (typeof createFailures)[number]) => {
    const requests: Array<{ method: string; path: string }> = [];
    const teardown = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<{
      readonly elapsed: number;
      readonly exit: Exit.Exit<void, unknown>;
    }>();
    const root = Effect.runFork(
      Effect.gen(function* () {
        const deleting = yield* Deferred.make<void>();
        const api: DataPlaneApiClient = {
          request: (request) => {
            requests.push({ method: request.method, path: request.path });
            if (request.path.startsWith("/containers/create?name=")) {
              return create === "transport"
                ? Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "test",
                      operation: "transport",
                      message: "socket down",
                      remediation: "retry",
                    }),
                  )
                : Effect.succeed({ status: 500, body: "create failed" });
            }
            if (request.method === "DELETE") {
              return Deferred.succeed(deleting, undefined).pipe(
                Effect.andThen(Effect.promise(() => teardown.promise)),
                Effect.as({ status: 204, body: "" }),
              );
            }
            return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
          },
          stream: () => Stream.empty,
        };
        const provider = makeProviderDataPlane({
          providerId: "test",
          api,
          capabilities: { volumeSnapshot: "none" },
          redactor: passthroughRedactor,
        });
        const work =
          mode === "buffered"
            ? provider.run(spec).pipe(Effect.asVoid)
            : provider.runStream(spec).pipe(Stream.runDrain);
        const child = yield* Effect.forkChild(
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            const inner = yield* Effect.forkChild(Effect.scoped(work));
            const exit = yield* Fiber.await(inner);
            return { elapsed: (yield* Clock.currentTimeMillis) - start, exit };
          }),
        );
        yield* Deferred.await(deleting);
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(child);
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.matchCause({
          onFailure: (cause) => {
            settled.reject(cause);
          },
          onSuccess: (value) => {
            settled.resolve(value);
          },
        }),
      ),
    );
    const watchdog = setTimeout(() => {
      settled.reject(new Error(`${mode} ${create} failed-create cleanup deadline did not settle`));
    }, 2000);
    try {
      const result = await settled.promise;
      expect(result.elapsed).toBe(10_000);
      expect(requests.filter((request) => request.method === "DELETE")).toEqual([
        expect.objectContaining({ method: "DELETE", path: expect.stringContaining("?force=true&v=true") }),
      ]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      if (!Exit.isFailure(result.exit)) return;
      const projected = failureOutcomeFromCause(result.exit.cause);
      expect(cleanupErrors(result.exit.cause)).toEqual([
        expect.objectContaining({
          _tag: "ProviderUnavailableError",
          operation: "run.create.remove",
          message: expect.stringContaining("timed out removing its helper container"),
        }),
      ]);
      expect(projected.error).toMatchObject(
        create === "transport"
          ? { _tag: "ProviderUnavailableError", operation: "transport", message: "socket down" }
          : {
              _tag: "ProviderUnavailableError",
              operation: "run.create",
              message: "The container engine couldn't create Lando's helper container (HTTP 500).",
              details: { status: 500 },
            },
      );
      expect(projected.additionalErrors).toEqual([
        {
          role: "cleanup",
          error: expect.objectContaining({
            _tag: "ProviderUnavailableError",
            operation: "run.create.remove",
          }),
        },
      ]);
      expect(roles(result.exit.cause)).toEqual(["unscoped", "cleanup"]);
    } finally {
      clearTimeout(watchdog);
      teardown.resolve();
      await Effect.runPromise(Fiber.interrupt(root));
    }
  },
  5000,
);
