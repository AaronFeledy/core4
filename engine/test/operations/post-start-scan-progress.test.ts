import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Schema } from "effect";

import { LandoEvent } from "@lando/sdk/events";
import type { EventServiceShape, ScanEndpoint, UrlScannerShape } from "@lando/sdk/services";

import { runPostStartScan } from "../../src/operations/post-start-scan.ts";
import { byTag, plan, web } from "./start-progress-topology-support.ts";

const makeHarness = () => {
  const events: LandoEvent[] = [];
  return {
    events,
    publish: (event: Parameters<EventServiceShape["publish"]>[0]) =>
      Effect.sync(() => {
        if (Schema.is(LandoEvent)(event)) events.push(event);
      }),
  };
};

const target = { service: web.name, url: "http://localhost:8080/" };
const scannerReturning = (endpoint: ScanEndpoint): UrlScannerShape => ({
  id: "stub",
  scan: (appId) => Effect.succeed({ appId, endpoints: [endpoint] }),
  detectCollisions: () => Effect.succeed([]),
});

test("progress publish defects do not prevent probing or fail start", async () => {
  // Given a failing progress publisher and an unreachable URL.
  let calls = 0;
  const scanner: UrlScannerShape = {
    id: "stub",
    scan: () =>
      Effect.sync(() => {
        calls++;
        return {
          appId: plan.id,
          endpoints: [{ ...target, outcome: "red", verdict: "lando-error", reachable: false }],
        };
      }),
    detectCollisions: () => Effect.succeed([]),
  };
  // When the scan runs despite publication defects.
  await Effect.runPromise(
    runPostStartScan({ scanner, plan, events: { publish: () => Effect.die("bus down") }, urls: [target] }),
  );
  // Then probing still completes successfully.
  expect(calls).toBe(1);
});

test("redacts scanner detail before task and envelope publication", async () => {
  const harness = makeHarness();
  const scanner: UrlScannerShape = {
    ...scannerReturning({ ...target, reachable: false, verdict: "lando-error" }),
    scan: (appId, options) =>
      Effect.gen(function* () {
        const detail = "proxy MY_TOKEN=abc123";
        yield* options?.onAttempt?.({
          ...target,
          attempt: 1,
          maxAttempts: 2,
          outcome: "red",
          verdict: "lando-error",
          detail,
        }) ?? Effect.void;
        return {
          appId,
          endpoints: [
            { ...target, reachable: false, outcome: "red" as const, verdict: "lando-error" as const, detail },
          ],
        };
      }),
  };
  const checks = await Effect.runPromise(
    runPostStartScan({ scanner, plan, urls: [target], events: harness }),
  );
  expect(JSON.stringify(harness.events)).not.toContain("abc123");
  expect(JSON.stringify(checks)).not.toContain("abc123");
  expect(checks[0]?.message).toContain("[redacted]");
  expect(byTag(harness.events, "task.detail")[0]?.line).toContain("[redacted]");
  expect(byTag(harness.events, "task.complete")[0]?.summary).toContain("[redacted]");
  expect(byTag(harness.events, "message.warn")[0]?.body).toContain("[redacted]");
});

test.each([
  { verdict: "ready", reachable: false, outcome: undefined, message: "200" },
  { verdict: "app-error", reachable: false, outcome: "info", message: "your app returned 200" },
  { verdict: "service-error", reachable: true, outcome: "warn", message: "web server returned 200" },
  { verdict: "lando-error", reachable: true, outcome: "warn", message: "unreachable: no response reported" },
] as const)("scan progress uses $verdict independently of reachability", async (row) => {
  // Given a verdict that cannot be inferred from reachability.
  const harness = makeHarness();
  // When the URL check settles.
  const checks = await Effect.runPromise(
    runPostStartScan({
      scanner: scannerReturning({
        ...target,
        reachable: row.reachable,
        verdict: row.verdict,
        statusCode: 200,
      }),
      plan,
      urls: [target],
      events: harness,
    }),
  );
  // Then both progress and result data preserve the owning verdict.
  const completed = byTag(harness.events, "task.complete");
  expect(completed[0]?.outcome).toBe(row.outcome);
  expect(completed[0]?.summary).toBe(`web ${target.url} · ${row.message}`);
  expect(checks[0]).toMatchObject({ verdict: row.verdict, message: `web ${target.url} · ${row.message}` });
});

test("only four URL rows start at once and each settles when its own probe returns", async () => {
  const harness = makeHarness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const gates = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
      const firstWave = yield* Deferred.make<void>();
      const fifthStarted = yield* Deferred.make<void>();
      const urls = gates.map((_, index) => ({ ...target, url: `${target.url}${index}` }));
      let active = 0;
      let maximum = 0;
      const scanner: UrlScannerShape = {
        ...scannerReturning({ ...target, reachable: true, verdict: "ready" }),
        scan: (appId, options) =>
          Effect.gen(function* () {
            const url = options?.urls?.[0];
            const index = urls.findIndex((row) => row.url === url?.url);
            const gate = gates[index];
            if (url === undefined || gate === undefined) return yield* Effect.die("unexpected target");
            active++;
            maximum = Math.max(maximum, active);
            if (active === 4) yield* Deferred.succeed(firstWave, undefined);
            if (index === 4) yield* Deferred.succeed(fifthStarted, undefined);
            yield* Deferred.await(gate);
            active--;
            return {
              appId,
              endpoints: [
                {
                  ...url,
                  reachable: true,
                  outcome: "green" as const,
                  verdict: "ready" as const,
                  statusCode: 200,
                },
              ],
            };
          }),
      };
      const fiber = yield* Effect.forkChild(runPostStartScan({ scanner, plan, events: harness, urls }));
      yield* Deferred.await(firstWave);
      expect(byTag(harness.events, "task.start")).toHaveLength(4);
      const second = gates[1];
      if (second === undefined) return yield* Effect.die("missing second target");
      yield* Deferred.succeed(second, undefined);
      yield* Deferred.await(fifthStarted);
      expect(byTag(harness.events, "task.complete").map((row) => row.taskId)).toEqual([
        `start-scan-${plan.id}:web-2`,
      ]);
      yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined));
      yield* Fiber.join(fiber);
      expect(maximum).toBe(4);
      expect(byTag(harness.events, "task.complete")).toHaveLength(5);
    }),
  );
});
