import { expect, test } from "bun:test";
import { FailureRoleAnnotation } from "@lando/sdk/command-result";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { supervisedExecStream } from "../src/exec-supervision.ts";
import { ctx, plan, service } from "./fixtures/environment-values.ts";
import { fixtureHelperMount, fixtureHelperOptions } from "./support/exec-supervision.ts";

test.each(["stopped", "joining", "running", "http-error", "unresponsive"] as const)(
  "a stalled cancellation disconnects and inspects the owned exec (%s)",
  async (outcome) => {
    const started = Deferred.makeUnsafe<void>();
    const signal = new AbortController();
    let attached: AbortSignal | undefined;
    let inspections = 0;
    const api: EngineHttpApi = {
      request: (request) => {
        if (request.path === "/exec/owned/json") {
          inspections++;
          expect(attached?.aborted).toBe(true);
          if (outcome === "unresponsive") return Effect.never;
          return Effect.succeed({
            status: outcome === "http-error" ? 500 : 200,
            body: JSON.stringify({
              Running: outcome === "running" || (outcome === "joining" && inspections < 4),
            }),
          });
        }
        return Effect.succeed({
          status: 200,
          body: JSON.stringify(
            request.method === "POST"
              ? { Id: "owned" }
              : {
                  Id: "container",
                  Mounts: [
                    {
                      Source: fixtureHelperMount.source,
                      Destination: fixtureHelperMount.target,
                      RW: false,
                    },
                  ],
                },
          ),
        });
      },
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            attached = request.signal;
            request.onResponseHead?.();
            yield* Deferred.succeed(started, undefined);
            return Stream.never;
          }),
        ),
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const begin = yield* Clock.currentTimeMillis;
        const child = yield* Effect.forkChild(
          Stream.runDrain(
            supervisedExecStream(
              plan,
              { app: plan.id, service: service.name },
              { command: ["payload"], signal: signal.signal },
              { api, ctx, ...fixtureHelperOptions },
            ),
          ).pipe(Effect.exit),
        );
        yield* Deferred.await(started);
        signal.abort("SIGINT");
        yield* TestClock.adjust("250 millis");
        expect(attached?.aborted).toBe(true);
        yield* TestClock.adjust("1500 millis");
        const exit = yield* Fiber.await(child);
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
        return { elapsed: (yield* Clock.currentTimeMillis) - begin, exit: exit.value };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(inspections).toBe(outcome === "joining" ? 4 : outcome === "running" ? 11 : 1);
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isSuccess(result.exit)) throw new Error("Cancellation succeeded");
    expect(Cause.hasInterrupts(result.exit.cause)).toBe(true);
    const errors = result.exit.cause.reasons.flatMap((reason) => {
      if (Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) !== "cleanup")
        return [];
      if (Cause.isDieReason(reason)) return [reason.defect];
      if (Cause.isFailReason(reason)) return [reason.error];
      return [];
    });
    expect(errors).toEqual(
      outcome === "stopped" || outcome === "joining"
        ? []
        : [
            expect.objectContaining({
              _tag: outcome === "running" ? "ServiceExecError" : "ProviderUnavailableError",
            }),
          ],
    );
    expect(result.elapsed).toBeLessThanOrEqual(1750);
  },
);
