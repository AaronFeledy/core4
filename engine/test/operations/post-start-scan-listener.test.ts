import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { LandoEvent } from "@lando/sdk/events";
import { type ListenerObservation, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ScanEndpoint, UrlScannerShape } from "@lando/sdk/services";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { runPostStartScan } from "../../src/operations/post-start-scan.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const service: ServicePlan = {
  ...web,
  endpoints: [{ _tag: "internal", protocol: "http", port: 3000, primary: true }],
  listenerAuthority: { owner: "application", daemon: "node", port: 3000, variables: ["PORT"] },
};
const plannedApp = { ...plan, services: { [web.name]: service } };
const target = {
  service: web.name,
  url: "http://web.example.test/",
  endpoint: { port: 3000, transport: "tcp", names: [], primary: true } as const,
};
const listener: ListenerObservation = {
  service: "web",
  port: 3000,
  transport: "tcp",
  basis: "primary-endpoint",
  state: "not-listening",
  listening: [],
};
const failed: ScanEndpoint = {
  ...target,
  reachable: true,
  verdict: "lando-error",
  outcome: "yellow",
  routerMarker: "upstream-unreachable",
  statusCode: 502,
};
/** A scanner row override; `undefined` clears an optional field of the failed baseline. */
type Clearable = "routerMarker" | "statusCode" | "detail";
type ScanRow = Partial<Omit<ScanEndpoint, Clearable>> & {
  readonly [K in Clearable]?: ScanEndpoint[K] | undefined;
};
const scannerReturning = (row: ScanRow = {}): UrlScannerShape => ({
  id: "test",
  scan: (appId, options) =>
    Effect.succeed({
      appId,
      endpoints: (options?.urls ?? []).map((url) => {
        const { routerMarker, statusCode, detail, ...rest } = { ...failed, ...url, ...row };
        return {
          ...rest,
          ...(routerMarker === undefined ? {} : { routerMarker }),
          ...(statusCode === undefined ? {} : { statusCode }),
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    }),
  detectCollisions: () => Effect.succeed([]),
});

test.each(
  [
    { routerMarker: "upstream-unreachable", reachable: true },
    { routerMarker: undefined, reachable: false, statusCode: undefined, detail: "connection refused" },
  ].flatMap((row) => ["not-listening", "listening"].map((state) => ({ ...row, state }))),
)("adds listener evidence and a warning action for %j", async ({ state, ...row }) => {
  // Given an unreachable expected listener and available socket evidence.
  const warnings: string[] = [];
  const observed: ListenerObservation = {
    ...listener,
    state: state === "listening" ? "listening" : "not-listening",
    listening: state === "listening" ? [{ port: 3000, address: "0.0.0.0" }] : [],
  };
  // When the scan finishes.
  const checks = await Effect.runPromise(
    runPostStartScan({
      plan: plannedApp,
      urls: [target],
      scanner: scannerReturning(row),
      observeListener: () => Effect.succeed(observed),
      events: {
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(LandoEvent)(event) && event._tag === "message.warn") warnings.push(event.body);
          }),
      },
    }),
  );
  // Then failure remains a warning, with evidence and authority advice.
  expect(checks[0]).toMatchObject({ verdict: "lando-error", listener: observed });
  const detail = row.routerMarker === undefined ? "connection refused" : "the router could not reach web";
  expect(warnings).toEqual([
    `Lando could not reach ${target.url}: ${detail}. ${state === "listening" ? "TCP 3000 has a non-loopback binding, but this endpoint remains unreachable. Check the network path and HTTP/TLS configuration for this endpoint." : "No TCP listener observed on 3000; observed ports: none. Make web listen on 3000. Make your server listen on 0.0.0.0:3000; your application owns this listener and Lando sets `PORT` to 3000."}`,
  ]);
});

test.each([
  { verdict: "ready", routerMarker: undefined },
  { verdict: "app-error", routerMarker: undefined },
  { verdict: "service-error", routerMarker: undefined },
  { verdict: "lando-error", routerMarker: "no-route", reachable: false },
  { verdict: "lando-error", routerMarker: "other-marker", reachable: false },
] satisfies ReadonlyArray<ScanRow>)("does no listener work for %j", async (row) => {
  // Given a verdict unrelated to service listener reachability.
  let observations = 0;
  // When every URL has that verdict.
  const checks = await Effect.runPromise(
    runPostStartScan({
      plan: plannedApp,
      urls: [target, { ...target, url: `${target.url}second` }],
      scanner: scannerReturning(row),
      observeListener: () => {
        observations++;
        return Effect.succeed(listener);
      },
      events: { publish: () => Effect.void },
    }),
  );
  // Then even constructing the observer is avoided.
  expect(observations).toBe(0);
  expect(checks.map((check) => check.listener)).toEqual([undefined, undefined]);
});

test.each([3000, 9000])(
  "shares one in-flight observation per service but skips port %s when mismatched",
  async (port) => {
    // Given simultaneous failures on multiple URLs across two services.
    let observations = 0;
    const api = { ...service, name: ServiceName.make("api") };
    // When observation yields before completing, so competing URL fibers overlap.
    const checks = await Effect.runPromise(
      runPostStartScan({
        plan: { ...plannedApp, services: { ...plannedApp.services, [api.name]: api } },
        urls: [
          target,
          { ...target, url: `${target.url}second` },
          { ...target, url: `${target.url}third` },
          { ...target, service: api.name, url: "http://api.example.test/" },
        ].map((url) => ({ ...url, endpoint: { ...url.endpoint, port } })),
        scanner: scannerReturning(),
        events: { publish: () => Effect.void },
        observeListener: (service) =>
          Effect.sync(() => {
            observations++;
          }).pipe(Effect.andThen(Effect.yieldNow), Effect.as({ ...listener, service: String(service.name) })),
      }),
    );
    // Then only matching endpoints share evidence, without racing duplicate reads.
    expect(observations).toBe(port === 3000 ? 2 : 0);
    expect(checks.map((check) => check.listener)).toEqual(
      port === 3000
        ? [listener, listener, listener, { ...listener, service: "api" }]
        : [undefined, undefined, undefined, undefined],
    );
  },
);

test("missing scan results do not imply a connection-level failure", async () => {
  let observations = 0;
  const checks = await Effect.runPromise(
    runPostStartScan({
      plan: plannedApp,
      urls: [target],
      scanner: { ...scannerReturning(), scan: (appId) => Effect.succeed({ appId, endpoints: [] }) },
      observeListener: () => {
        observations++;
        return Effect.succeed(listener);
      },
      events: { publish: () => Effect.void },
    }),
  );
  expect(observations).toBe(0);
  expect(checks[0]).toMatchObject({ verdict: "lando-error", detail: "no response reported" });
  expect(checks[0]?.listener).toBeUndefined();
});

test("unavailable observation preserves the original warning", async () => {
  // Given a best-effort observer without evidence.
  const warnings: string[] = [];
  // When an upstream cannot be reached.
  const checks = await Effect.runPromise(
    runPostStartScan({
      plan: plannedApp,
      urls: [target],
      scanner: scannerReturning(),
      observeListener: () => Effect.succeed(undefined),
      events: {
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(LandoEvent)(event) && event._tag === "message.warn") warnings.push(event.body);
          }),
      },
    }),
  );
  // Then absence is not diagnosed as an absent listener.
  expect(checks[0]?.listener).toBeUndefined();
  expect(warnings).toEqual([`Lando could not reach ${target.url}: the router could not reach web`]);
});

test("redacts authority advice in scan warnings", async () => {
  // Given a secret-bearing authority supplied by a service type.
  const warnings: string[] = [];
  const redaction = makeRedactionService();
  await Effect.runPromise(redaction.registerValues(["authority-canary"]));
  // When the diagnostic is published.
  await Effect.runPromise(
    runPostStartScan({
      plan: {
        ...plannedApp,
        services: {
          [web.name]: {
            ...service,
            listenerAuthority: {
              owner: "launcher",
              daemon: "node",
              port: 3000,
              setting: "--token authority-canary",
            },
          },
        },
      },
      urls: [target],
      scanner: scannerReturning(),
      observeListener: () => Effect.succeed(listener),
      events: {
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(LandoEvent)(event) && event._tag === "message.warn") warnings.push(event.body);
          }),
      },
    }).pipe(Effect.provideService(RedactionService, redaction)),
  );
  // Then the action cannot leak the authority's secret.
  expect(warnings[0]).toContain("--token [redacted]");
  expect(warnings[0]).not.toContain("authority-canary");
});

test("interruption during listener observation propagates and settles the scan", async () => {
  // Given an observation that is still in flight.
  const events: LandoEvent[] = [];
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const observing = yield* Deferred.make<void>();
      // When the caller interrupts after the read starts.
      const fiber = yield* Effect.forkChild(
        runPostStartScan({
          plan: plannedApp,
          urls: [target, { ...target, url: `${target.url}second` }],
          scanner: scannerReturning(),
          observeListener: () => Deferred.succeed(observing, undefined).pipe(Effect.andThen(Effect.never)),
          events: {
            publish: (event) =>
              Effect.sync(() => {
                if (Schema.is(LandoEvent)(event)) events.push(event);
              }),
          },
        }),
      );
      yield* Deferred.await(observing);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  // Then cancellation is never converted to a warning-only success.
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
    { summary: `${plan.name} check interrupted`, failed: 2 },
  ]);
});
