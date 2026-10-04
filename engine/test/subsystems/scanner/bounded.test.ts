import { describe, expect, test } from "bun:test";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ServiceName } from "@lando/sdk/schema";
import { makeUrlScanner } from "../../../src/subsystems/scanner/live.ts";
import { appId, endpointsOf, publishedEndpoint, runExitUnderClock, successOf } from "./support.ts";

const web = ServiceName.make("web");
const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);

const transport = (http: HttpClient.HttpClient) => ({
  http,
  listEndpoints: source.listEndpoints,
});

const scriptedHttp = (
  run: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never, Scope.Scope>,
): HttpClient.HttpClient =>
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.provideService(run(request), Scope.Scope, Context.getUnsafe(fiber.context, Scope.Scope)),
  );

describe("bounded scanner", () => {
  test("accepts headers without pulling an endless body", async () => {
    // Given: headers arrive; body is an open stream the scanner must not drain.
    let closed = 0;
    let streamAccessed = 0;
    const scanner = makeUrlScanner(
      transport(
        scriptedHttp((request) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            );
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  start() {
                    /* never closes */
                  },
                }),
                { status: 200 },
              ),
            );
            return new Proxy(response, {
              get(target, prop, receiver) {
                if (prop === "stream") streamAccessed += 1;
                return Reflect.get(target, prop, receiver);
              },
            });
          }),
        ),
      ),
      { retry: 1, deadlineMs: 250 },
    );
    // When: the deadline can advance if the scanner waits for the body.
    const timed = await runExitUnderClock(scanner.scan(appId), "1 second");
    // Then: status alone decides the verdict and scope cleanup still runs.
    expect(successOf(timed.exit).endpoints[0]?.outcome).toBe("green");
    expect(streamAccessed).toBe(0);
    expect(closed).toBe(1);
    expect(timed.elapsedMs).toBe(0);
  });

  test("closes in-flight request scope when cancelled", async () => {
    // Given: a request signals acquisition but never sends headers.
    let closed = 0;
    const acquired = await Effect.runPromise(Deferred.make<void>());
    const scanner = makeUrlScanner(
      transport(
        scriptedHttp(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            );
            yield* Deferred.succeed(acquired, undefined);
            return yield* Effect.never;
          }),
        ),
      ),
    );
    // When: interrupt only after the request has entered its scope.
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(scanner.scan(appId));
        yield* Deferred.await(acquired);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    // Then: interruption is preserved and the request is released exactly once.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(closed).toBe(1);
  });

  test("limits active target probes to four", async () => {
    // Given: nine targets with overlapping, scoped requests.
    let active = 0;
    let peak = 0;
    const scanner = makeUrlScanner(
      transport(
        scriptedHttp((request) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active += 1;
                peak = Math.max(peak, active);
              }),
              () =>
                Effect.sync(() => {
                  active -= 1;
                }),
            );
            yield* Effect.sleep("100 millis");
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
          }),
        ),
      ),
      { retry: 1 },
    );
    const urls = Array.from({ length: 9 }, (_, index) => ({
      service: web,
      url: `http://localhost:${8080 + index}/`,
    }));
    // When: all target probes finish.
    const timed = await runExitUnderClock(scanner.scan(appId, { urls }), "1 second");
    // Then: four slots, including scope cleanup, bound concurrent work.
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(successOf(timed.exit).endpoints).toHaveLength(9);
    expect(timed.elapsedMs).toBe(300);
  });

  test.each([0, 25])(
    "reports measured deadline instead of a stale response with %ims cleanup",
    async (cleanupMs) => {
      // Given: one rejected response followed by a request stuck before headers.
      let attempts = 0;
      const scanner = makeUrlScanner(
        transport(
          scriptedHttp((request) =>
            Effect.gen(function* () {
              attempts += 1;
              if (attempts === 1)
                return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
              yield* Effect.addFinalizer(() => Effect.sleep(`${cleanupMs} millis`));
              return yield* Effect.never;
            }),
          ),
        ),
        { retry: 3, delaySeconds: 0.1, timeoutSeconds: 5, deadlineMs: 250 },
      );
      // When: the overall deadline interrupts the second attempt.
      const timed = await runExitUnderClock(scanner.scan(appId), "1 second");
      // Then: the deadline, not stale HTTP 503 or configured five seconds, is reported.
      expect(successOf(timed.exit).endpoints[0]).toMatchObject({
        outcome: "red",
        detail: `deadline exceeded after ${250 + cleanupMs}ms`,
      });
      expect(timed.elapsedMs).toBe(250 + cleanupMs);
      expect(attempts).toBe(2);
    },
  );

  test("reports elapsed attempt timeout when retries exhaust before the deadline", async () => {
    // Given: two requests stall, with a retry delay between them.
    const scanner = makeUrlScanner(transport(scriptedHttp(() => Effect.never)), {
      retry: 2,
      delaySeconds: 0.05,
      timeoutSeconds: 0.1,
      deadlineMs: 1000,
    });
    // When: both per-attempt timers expire before the overall deadline.
    const timed = await runExitUnderClock(scanner.scan(appId), "1 second");
    // Then: the diagnostic includes the entire wait, not just one attempt's limit.
    expect(successOf(timed.exit).endpoints[0]).toMatchObject({
      outcome: "red",
      detail: "timeout after 250ms",
    });
    expect(timed.elapsedMs).toBe(250);
  });

  test("reports real elapsed deadline timing", async () => {
    // Given: a request that never produces headers, using the live Effect clock.
    const scanner = makeUrlScanner(transport(scriptedHttp(() => Effect.never)), {
      retry: 1,
      timeoutSeconds: 5,
      deadlineMs: 60,
    });
    const started = performance.now();
    // When: the actual timer expires.
    const result = await Effect.runPromise(scanner.scan(appId));
    const elapsed = performance.now() - started;
    // Then: diagnostic time agrees with elapsed time, not the five-second setting.
    const detail = result.endpoints[0]?.detail ?? "";
    expect(detail).toMatch(/^deadline exceeded after \d+ms$/u);
    const reported = Number(detail.match(/(\d+)ms$/u)?.[1]);
    expect(reported).toBeGreaterThanOrEqual(50);
    expect(reported).toBeLessThanOrEqual(elapsed + 5);
    expect(elapsed - reported).toBeLessThan(100);
    expect(elapsed).toBeLessThan(1000);
  });
});
