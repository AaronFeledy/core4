import { expect, test } from "bun:test";
import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

const spec = { image: "alpine:3.20", command: ["true"], remove: true } as const;
const outcomes = ["success", "failed-body", "nonzero", "interrupted"] as const;
const modes = ["buffered", "streamed"] as const;
type Outcome = (typeof outcomes)[number];
type Mode = (typeof modes)[number];

const cases = modes.flatMap((mode) => outcomes.map((outcome) => [mode, outcome] as const));

const recordedPlane = (
  requests: Array<{ method: string; path: string }>,
  outcome: Outcome,
  gates: {
    readonly waiting: Deferred.Deferred<void>;
    readonly deleting: Deferred.Deferred<void>;
    readonly teardown: Promise<void>;
  },
) => {
  const api: DataPlaneApiClient = {
    request: (request) => {
      requests.push({ method: request.method, path: request.path });
      if (request.method === "DELETE") {
        return Deferred.succeed(gates.deleting, undefined).pipe(
          Effect.andThen(Effect.promise(() => gates.teardown)),
          Effect.as({ status: 204, body: "" }),
        );
      }
      if (request.path.endsWith("/start") && outcome === "failed-body") {
        return Effect.succeed({ status: 500, body: "start failed" });
      }
      if (request.path.endsWith("/wait") && outcome === "interrupted") {
        return Deferred.succeed(gates.waiting, undefined).pipe(Effect.andThen(Effect.never));
      }
      if (request.path.endsWith("/json")) {
        return Effect.succeed({
          status: 200,
          body: JSON.stringify({ State: { ExitCode: outcome === "nonzero" ? 9 : 0 } }),
        });
      }
      return Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: "{}" });
    },
    stream: () => Stream.empty,
  };
  return makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "none" },
    redactDetails: (value) => value,
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
  "%s %s bounds a DELETE that never finishes",
  async (mode: Mode, outcome: Outcome) => {
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
        const provider = recordedPlane(requests, outcome, { waiting, deleting, teardown: teardown.promise });
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
            _tag: "VolumeOperationError",
            operation,
            message:
              mode === "buffered" ? "Provider ephemeral run failed." : "Provider ephemeral stream failed.",
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
            _tag: "VolumeOperationError",
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
