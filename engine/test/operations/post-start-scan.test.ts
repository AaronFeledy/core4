import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import { LandoEvent } from "@lando/sdk/events";
import { ServiceName } from "@lando/sdk/schema";
import type { EventServiceShape, ScanEndpoint, UrlScannerShape } from "@lando/sdk/services";

import { runPostStartScan } from "../../src/operations/post-start-scan.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const url = "http://localhost:8080/";
const target = { service: web.name, url };
const parentId = `start-scan-${plan.id}`;
const taskId = `${parentId}:web-1`;
const label = `web ${url}`;
const endpoint = (overrides: Partial<ScanEndpoint> = {}): ScanEndpoint => ({
  ...target,
  reachable: true,
  verdict: "ready",
  outcome: "green",
  statusCode: 200,
  ...overrides,
});
const collector = () => {
  const published: LandoEvent[] = [];
  return {
    published,
    publish: (event: Parameters<EventServiceShape["publish"]>[0]) =>
      Effect.sync(() => {
        if (Schema.is(LandoEvent)(event)) published.push(event);
      }),
  };
};
const scannerReturning = (endpoints: ReadonlyArray<ScanEndpoint>): UrlScannerShape => ({
  id: "stub",
  scan: (appId, options) =>
    Effect.succeed({
      appId,
      endpoints: endpoints.filter((row) =>
        options?.urls?.some((url) => url.service === row.service && url.url === row.url),
      ),
    }),
  detectCollisions: () => Effect.succeed([]),
});
const project = (events: ReadonlyArray<LandoEvent>) =>
  events.map((event) => {
    switch (event._tag) {
      case "task.tree.start":
        return [event._tag, event.parentId, event.label, event.children];
      case "task.start":
        return [event._tag, event.taskId, event.label];
      case "task.complete":
        return [event._tag, event.taskId, event.summary, event.outcome];
      case "task.fail":
        return [event._tag, event.taskId, event.summary];
      case "task.detail":
        return [event._tag, event.taskId, event.stream, event.line];
      case "task.tree.complete":
        return [event._tag, event.summary, event.succeeded, event.failed];
      case "message.warn":
        return [event._tag, event.body];
      default:
        throw new Error(`Unexpected event: ${event._tag}`);
    }
  });
const opening = [
  ["task.tree.start", parentId, `Checking ${plan.name}`, [taskId]],
  ["task.start", taskId, label],
];

describe("runPostStartScan", () => {
  test("app errors are neutral result data, not command warnings", async () => {
    const events = collector();
    const result = await Effect.runPromise(
      runPostStartScan({
        scanner: scannerReturning([endpoint({ verdict: "app-error", outcome: "yellow", statusCode: 500 })]),
        plan,
        events,
        urls: [target],
      }),
    );
    expect(result).toMatchObject([
      { id: `http:web:${url}`, kind: "http", verdict: "app-error", statusCode: 500 },
    ]);
    expect(project(events.published)).toEqual([
      ...opening,
      ["task.complete", taskId, `${label} · your app returned 500`, "info"],
      ["task.tree.complete", `${plan.name} checked · 1 URL returned errors`, 1, 0],
    ]);
  });

  test.each([
    ["no-route", "no route matched this hostname"],
    ["upstream-unreachable", "the router could not reach web"],
  ])("explains router marker %s as a Lando failure", async (routerMarker, detail) => {
    const events = collector();
    const result = await Effect.runPromise(
      runPostStartScan({
        scanner: scannerReturning([endpoint({ verdict: "lando-error", routerMarker, statusCode: 404 })]),
        plan,
        events,
        urls: [target],
      }),
    );
    expect(result[0]?.detail).toBe(detail);
    expect(events.published.filter((event) => event._tag === "message.warn")).toMatchObject([
      { body: `Lando could not reach ${url}: ${detail}` },
    ]);
  });
  test("publishes the exact all-green task lifecycle and forwards plan and singleton URL", async () => {
    const events = collector();
    const scanner: UrlScannerShape = {
      ...scannerReturning([]),
      scan: (appId, options) => {
        expect(appId).toBe(plan.id);
        expect(options?.plan).toBe(plan);
        expect(options?.urls).toEqual([target]);
        return Effect.succeed({ appId, endpoints: [endpoint()] });
      },
    };
    await Effect.runPromise(runPostStartScan({ scanner, plan, events, urls: [target] }));
    expect(project(events.published)).toEqual([
      ...opening,
      ["task.complete", taskId, `${label} · 200`, undefined],
      ["task.tree.complete", `${plan.name} answered on 1 URL`, 1, 0],
    ]);
  });

  test("settles mixed verdicts independently and preserves envelope warnings", async () => {
    const events = collector();
    const endpoints = [
      endpoint(),
      endpoint({ url: `${url}yellow`, verdict: "service-error", outcome: "yellow", statusCode: 502 }),
      endpoint({
        service: ServiceName.make("api"),
        url: `${url}red`,
        outcome: "red",
        verdict: "lando-error",
        reachable: false,
        detail: "connection refused",
      }),
    ];
    await Effect.runPromise(
      runPostStartScan({ scanner: scannerReturning(endpoints), plan, events, urls: endpoints }),
    );
    const ids = [taskId, `${parentId}:web-2`, `${parentId}:api-1`];
    const summaries = [
      `${label} · 200`,
      `web ${url}yellow · web server returned 502`,
      `api ${url}red · unreachable: connection refused`,
    ];
    expect(project(events.published)).toEqual([
      ["task.tree.start", parentId, `Checking ${plan.name}`, ids],
      ["task.start", ids[0], label],
      ["task.complete", ids[0], summaries[0], undefined],
      ["task.start", ids[1], `web ${url}yellow`],
      ["task.complete", ids[1], summaries[1], "warn"],
      ["task.start", ids[2], `api ${url}red`],
      ["task.complete", ids[2], summaries[2], "warn"],
      ["message.warn", `Lando could not reach ${url}red: connection refused`],
      ["task.tree.complete", `${plan.name} checked · 1 URL returned errors, 1 unreachable`, 3, 0],
    ]);
  });

  test("warns for one failed scan without failing start or losing other URL verdicts", async () => {
    const events = collector();
    const scanner: UrlScannerShape = {
      ...scannerReturning([]),
      scan: (appId, options) =>
        options?.urls?.[0]?.url === url
          ? Effect.fail(new ScannerError({ message: "scan blew up", scannerId: "stub" }))
          : Effect.succeed({ appId, endpoints: [endpoint({ url: `${url}ready` })] }),
    };
    await Effect.runPromise(
      runPostStartScan({ scanner, plan, events, urls: [target, { ...target, url: `${url}ready` }] }),
    );
    expect(project(events.published)).toEqual([
      ["task.tree.start", parentId, `Checking ${plan.name}`, [taskId, `${parentId}:web-2`]],
      ["task.start", taskId, label],
      ["task.complete", taskId, `${label} · unreachable: scan blew up`, "warn"],
      ["message.warn", `Lando could not reach ${url}: scan blew up`],
      ["task.start", `${parentId}:web-2`, `web ${url}ready`],
      ["task.complete", `${parentId}:web-2`, `web ${url}ready · 200`, undefined],
      ["task.tree.complete", `${plan.name} checked · 1 unreachable`, 2, 0],
    ]);
  });

  test("publishes only non-green attempt details before settling", async () => {
    const events = collector();
    const scanner: UrlScannerShape = {
      ...scannerReturning([]),
      scan: (appId, options) =>
        Effect.gen(function* () {
          yield* options?.onAttempt?.({
            ...target,
            attempt: 1,
            maxAttempts: 2,
            outcome: "yellow",
            verdict: "service-error",
            statusCode: 502,
            detail: "HTTP 502",
          }) ?? Effect.void;
          yield* options?.onAttempt?.({
            ...target,
            attempt: 2,
            maxAttempts: 2,
            outcome: "green",
            verdict: "ready",
            statusCode: 200,
            detail: "HTTP 200",
          }) ?? Effect.void;
          return { appId, endpoints: [endpoint()] };
        }),
    };
    await Effect.runPromise(runPostStartScan({ scanner, plan, events, urls: [target] }));
    expect(project(events.published)).toEqual([
      ...opening,
      ["task.detail", taskId, "stderr", "attempt 1/2: HTTP 502"],
      ["task.complete", taskId, `${label} · 200`, undefined],
      ["task.tree.complete", `${plan.name} answered on 1 URL`, 1, 0],
    ]);
  });

  test("external cancellation settles the tree and still interrupts", async () => {
    const events = collector();
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const probing = yield* Deferred.make<void>();
        const scanner: UrlScannerShape = {
          ...scannerReturning([]),
          scan: () => Deferred.succeed(probing, undefined).pipe(Effect.andThen(Effect.never)),
        };
        const fiber = yield* Effect.forkChild(runPostStartScan({ scanner, plan, events, urls: [target] }));
        yield* Deferred.await(probing);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(project(events.published)).toEqual([
      ...opening,
      ["task.fail", taskId, `${plan.name} check interrupted`],
      ["task.tree.complete", `${plan.name} check interrupted`, 0, 1],
    ]);
  });
});
