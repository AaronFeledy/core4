import { expect, test } from "bun:test";
import { Clock, Effect, Fiber } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import { acquisitionStateFile, routeFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { makeAckStore } from "./observe-routes-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

const first = httpsRoutes[0];
if (first === undefined) throw new Error("route fixture missing");
const route = { ...first, scheme: "http" as const };

test.each(["unknown", "missing", "hung"] as const)(
  "bounds perpetual %s evidence at the 30-second global deadline",
  async (kind) => {
    const fixture = makeAcceptanceFixture("win32");
    const signals: AbortSignal[] = [];
    const canary = "secret-config-and-api-canary";
    const mutations: string[] = [];
    const service = makeTraefikRouterService({
      ...fixture.dependencies,
      paths: { ...fixture.dependencies.paths, platform: "win32" },
      stateStore: makeAckStore(mutations),
      globalApp: { ...fixture.dependencies.globalApp, restartRunningService: () => Effect.succeed(true) },
      httpClient: HttpClient.make((request, _url, signal) => {
        signals.push(signal);
        if (kind === "hung") return Effect.never;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            kind === "unknown"
              ? new Response(`{${canary}`, { headers: { "content-type": "application/json" } })
              : Response.json({ routers: {}, services: {}, sensitive: canary }),
          ),
        );
      }),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(service.applyRoutes([route], app).pipe(Effect.result));
        yield* TestClock.adjust(29999);
        expect(mutations).not.toContain("ack:set");
        expect(yield* service.readAppliedRoutes(app)).toEqual([]);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(fiber);
        expect(yield* Clock.currentTimeMillis).toBe(30000);
        return result;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError" } });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("lastError");
    expect(JSON.stringify(result)).toContain("lando global:logs");
    expect(mutations).not.toContain("ack:set");
    expect(signals.length).toBe(kind === "hung" ? 1 : 120);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  },
);

test("interrupts in-flight HTTP with scoped cleanup and no Windows acknowledgement", async () => {
  const fixture = makeAcceptanceFixture("win32");
  const signals: AbortSignal[] = [];
  const mutations: string[] = [];
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    paths: { ...fixture.dependencies.paths, platform: "win32" },
    stateStore: makeAckStore(mutations),
    globalApp: { ...fixture.dependencies.globalApp, restartRunningService: () => Effect.succeed(true) },
    httpClient: HttpClient.make((_request, _url, signal) => {
      signals.push(signal);
      return Effect.never;
    }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(service.applyRoutes([route], app));
      yield* TestClock.adjust(0);
      expect(signals).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
      expect(yield* service.readAppliedRoutes(app)).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(mutations).not.toContain("ack:set");
});

test.each(["http", "ownership", "acquisition", "corrupt"] as const)(
  "fails before mutation when %s evidence prerequisites are absent",
  async (missing) => {
    const fixture = makeAcceptanceFixture();
    const { httpClient, ...withoutHttp } = fixture.dependencies;
    const { ownedPublishPorts, ...withoutOwnership } = fixture.dependencies.globalApp;
    if (missing === "acquisition") fixture.files.delete(acquisitionStateFile(fixture.dependencies.paths));
    if (missing === "corrupt")
      fixture.files.set(acquisitionStateFile(fixture.dependencies.paths), "not-json");
    const dependencies =
      missing === "http"
        ? withoutHttp
        : missing === "ownership"
          ? { ...fixture.dependencies, globalApp: withoutOwnership }
          : fixture.dependencies;
    const before = [...fixture.files];

    const result = await Effect.runPromise(
      makeTraefikRouterService(dependencies).applyRoutes([route], app).pipe(Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError" } });
    expect(fixture.operations).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect([...fixture.files]).toEqual(before);
    expect(fixture.runtime.requests).toEqual([]);
  },
);

test.each(["linux", "win32"] as const)(
  "repeated %s withdrawals need no API or ownership availability",
  async (platform) => {
    const fixture = makeAcceptanceFixture();
    const { httpClient, ...dependencies } = fixture.dependencies;
    const paths = { ...dependencies.paths, platform };
    const service = makeTraefikRouterService({
      ...dependencies,
      paths,
      globalApp: {
        ensureRunning: () => Effect.succeed([]),
        restartRunningService: () => Effect.succeed(false),
      },
    });
    fixture.files.set(routeFile(paths, app), "persisted route");
    fixture.files.delete(acquisitionStateFile(paths));

    await Effect.runPromise(service.applyRoutes([], app));
    await Effect.runPromise(service.applyRoutes([], app));
    await Effect.runPromise(service.removeRoutes(app));
    await Effect.runPromise(service.removeRoutes(app));

    expect(fixture.files.has(routeFile(paths, app))).toBe(false);
    expect(fixture.runtime.requests).toEqual([]);
  },
);
