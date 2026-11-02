import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit } from "effect";

import { commonContainerLabels } from "@lando/container-runtime/plan";
import {
  ProviderUnavailableError,
  ServiceNotFoundError,
  ServiceRestartWouldRecreateError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import type { ApplyOptions, ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService } from "@lando/sdk/test";

import { restartApp } from "../../src/operations/restart.ts";
import { withAcceleratedBind } from "../accelerated-plan.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const redis: ServicePlan = {
  ...web,
  name: ServiceName.make("redis"),
  type: "redis",
  primary: false,
  command: ["redis-server"],
  endpoints: [
    {
      _tag: "published",
      port: 6379,
      protocol: "tcp",
      name: "redis",
      publication: {},
    },
  ],
};

const worker: ServicePlan = {
  ...redis,
  name: ServiceName.make("worker"),
  type: "worker",
  command: ["node", "worker.js"],
  endpoints: [],
};

const twoServicePlan = (): AppPlan => ({
  ...plan,
  services: { [web.name]: web, [redis.name]: redis },
});

const threeServicePlan = (): AppPlan => ({
  ...plan,
  services: { [web.name]: web, [redis.name]: redis, [worker.name]: worker },
});

const runtimeFor = (
  plannedApp: AppPlan,
  service: ServiceName,
  extras: Partial<ServiceRuntimeInfo> = {},
): ServiceRuntimeInfo => ({
  app: plannedApp.id,
  service,
  providerId: plannedApp.provider,
  status: "running",
  state: "running",
  containerId: `cid-${String(service)}`,
  publications: {
    status: "present",
    bindings:
      service === redis.name
        ? [{ port: 6379, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 34567 }]
        : service === web.name
          ? [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }]
          : [],
  },
  ...extras,
});

const runSelected = (
  plannedApp: AppPlan,
  options: Parameters<typeof makeHarness>[0] & {
    readonly services?: ReadonlyArray<ServiceName>;
    readonly signal?: AbortSignal;
  } = {},
) => {
  const applyCalls: Array<{ readonly plan: AppPlan; readonly options: ApplyOptions }> = [];
  const stopCalls: ServiceName[] = [];
  const destroyCalls: number[] = [];
  const applyRoutes: number[] = [];
  const removeRoutes: string[] = [];
  const runtimes = new Map<string, ServiceRuntimeInfo>(
    Object.values(plannedApp.services).map((service) => [
      String(service.name),
      runtimeFor(plannedApp, service.name),
    ]),
  );
  const harness = makeHarness({
    plannedApp,
    onApply: (applied, applyOptions) => {
      applyCalls.push({ plan: applied, options: applyOptions ?? { reconcile: false } });
      if (applyOptions?.reconcile === true || applyOptions?.forbidRecreate !== true) {
        for (const service of Object.values(applied.services)) {
          const current = runtimes.get(String(service.name));
          if (current === undefined) continue;
          runtimes.set(String(service.name), {
            ...current,
            containerId: `recreated-${String(service.name)}`,
          });
        }
      }
    },
    onStop: (target) => {
      stopCalls.push(target.service);
    },
    onDestroy: () => {
      destroyCalls.push(1);
    },
    inspect: (target) =>
      Effect.succeed(runtimes.get(String(target.service)) ?? runtimeFor(plannedApp, target.service)),
    ...options,
  });
  const operation = restartApp(
    {
      ...(options.services === undefined ? {} : { services: options.services }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    {
      plan: plannedApp,
      root: plannedApp.root,
      app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    },
  ).pipe(
    Effect.provideService(RouterService, {
      ...TestRouterService,
      applyRoutes: (routes, app) =>
        Effect.sync(() => {
          applyRoutes.push(routes.length);
        }).pipe(Effect.andThen(TestRouterService.applyRoutes(routes, app))),
      removeRoutes: (app) => Effect.sync(() => void removeRoutes.push(String(app))),
    }),
    Effect.provide(harness.layer),
  );
  return { harness, operation, applyCalls, stopCalls, destroyCalls, applyRoutes, removeRoutes, runtimes };
};

describe("selected service restart", () => {
  test.each(["missing", "changed"] as const)(
    "refuses %s create config before stopping any selected service",
    async (scenario) => {
      // Given two selected services and an old or missing create-config label on web.
      const original = twoServicePlan();
      const desired: AppPlan = {
        ...original,
        services: {
          ...original.services,
          [web.name]: { ...web, environment: { ...web.environment, MODE: "after" } },
        },
      };
      const selected = runSelected(desired, {
        services: [web.name, redis.name],
        inspect: (target) =>
          Effect.succeed(
            runtimeFor(desired, target.service, {
              labels:
                target.service === web.name
                  ? scenario === "missing"
                    ? {}
                    : commonContainerLabels(original, web)
                  : commonContainerLabels(original, redis),
            }),
          ),
      });
      // When selected restart preflights the whole selection.
      const error = await Effect.runPromise(Effect.flip(selected.operation));
      // Then it refuses config recreation before stopping even an unchanged selected service.
      expect(error).toMatchObject({
        _tag: "ServiceRestartWouldRecreateError",
        reason: "config",
        service: "web",
      });
      if (!(error instanceof ServiceRestartWouldRecreateError)) {
        throw new TypeError("expected ServiceRestartWouldRecreateError");
      }
      expect(error.remediation).toContain("lando rebuild -s web");
      expect(selected.stopCalls).toEqual([]);
      expect(selected.applyCalls).toEqual([]);
    },
  );

  test("refuses a missing container before stopping any selected service", async () => {
    // Given the provider's missing-container inspect response.
    const selected = runSelected(twoServicePlan(), {
      services: [web.name, redis.name],
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "stopped",
          publications: { status: "missing" },
        }),
    });
    // When a selected restart runs.
    const error = await Effect.runPromise(Effect.flip(selected.operation));
    // Then it refuses before changing either service.
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
  });

  test("does not stop services when the restart signal is already aborted", async () => {
    const selected = runSelected(twoServicePlan(), { services: [redis.name], signal: AbortSignal.abort() });

    const exit = await Effect.runPromiseExit(selected.operation);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
  });

  test("does not stop the next selected service after cancellation during stop", async () => {
    const controller = new AbortController();
    const stopped: ServiceName[] = [];
    const selected = runSelected(threeServicePlan(), {
      services: [web.name, worker.name],
      signal: controller.signal,
      onStop: (target) => {
        stopped.push(target.service);
        controller.abort();
      },
    });

    const exit = await Effect.runPromiseExit(selected.operation);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(stopped).toEqual([worker.name]);
    expect(selected.applyCalls).toEqual([]);
    expect(byTag(selected.harness.events, "post-restart")).toEqual([]);
  });

  test("interrupts an in-flight apply when the restart signal aborts", async () => {
    const controller = new AbortController();
    const selected = runSelected(twoServicePlan(), {
      services: [redis.name],
      signal: controller.signal,
      onApply: () => controller.abort(),
      applyEffect: Effect.never,
    });

    const exit = await Effect.runPromiseExit(selected.operation);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(byTag(selected.harness.events, "post-restart")).toEqual([]);
  });

  test("restarts one service and leaves the others' container IDs and host ports in place", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [redis.name] });

    const result = await Effect.runPromise(selected.operation);

    expect(selected.destroyCalls).toEqual([]);
    expect(selected.stopCalls).toEqual([redis.name]);
    expect(selected.applyCalls).toHaveLength(1);
    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual(["redis"]);
    expect(selected.applyCalls[0]?.options).toMatchObject({
      reconcile: false,
      forbidRecreate: true,
    });
    expect(Object.keys(selected.applyCalls[0]?.options.recordedPlan?.services ?? {})).toEqual([
      "web",
      "redis",
    ]);
    expect(selected.runtimes.get("web")?.containerId).toBe("cid-web");
    expect(selected.runtimes.get("redis")?.containerId).toBe("cid-redis");
    const redisHttp = selected.runtimes.get("redis")?.publications;
    expect(redisHttp?.status === "present" ? redisHttp.bindings[0]?.hostPort : undefined).toBe(34567);
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["redis"]);
  });

  test("stops multiple selected services in reverse plan order", async () => {
    const plannedApp = threeServicePlan();
    const selected = runSelected(plannedApp, { services: [web.name, worker.name] });

    const result = await Effect.runPromise(selected.operation);

    expect(selected.stopCalls).toEqual([worker.name, web.name]);
    expect(selected.destroyCalls).toEqual([]);
    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual(["web", "worker"]);
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["web", "worker"]);
    expect(selected.runtimes.get("redis")?.containerId).toBe("cid-redis");
  });

  test("refuses before stop when publish-port, bind-source, or network drift would recreate", async () => {
    const cases: Array<{
      readonly extras: Partial<ServiceRuntimeInfo>;
      readonly reason: ServiceRestartWouldRecreateError["reason"];
    }> = [
      { extras: { publishFingerprint: "8080/tcp@127.0.0.1:18080" }, reason: "publish-port" },
      { extras: { bindSources: { "/run/lando/ssh-agent": "bind:/tmp/old" } }, reason: "bind-source" },
      { extras: { networkNames: ["unrelated"] }, reason: "network" },
    ];
    for (const testCase of cases) {
      const plannedApp = twoServicePlan();
      const selected = runSelected(plannedApp, {
        services: [web.name],
        inspect: () =>
          Effect.succeed(
            runtimeFor(plannedApp, web.name, {
              publishFingerprint: "",
              bindSources: {},
              networkNames: [],
              ...testCase.extras,
            }),
          ),
      });
      const error = await Effect.runPromise(Effect.flip(selected.operation));
      expect(error).toBeInstanceOf(ServiceRestartWouldRecreateError);
      if (!(error instanceof ServiceRestartWouldRecreateError)) {
        throw new TypeError("expected ServiceRestartWouldRecreateError");
      }
      expect(error).toMatchObject({
        _tag: "ServiceRestartWouldRecreateError",
        service: "web",
        reason: testCase.reason,
      });
      expect(error.remediation).toContain("lando rebuild -s web");
      expect(selected.stopCalls).toEqual([]);
      expect(selected.applyCalls).toEqual([]);
    }
  });

  test("unknown service fails with ServiceNotFoundError before provider action", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [ServiceName.make("missing")] });

    const error = await Effect.runPromise(Effect.flip(selected.operation));

    expect(error).toBeInstanceOf(ServiceNotFoundError);
    expect(error).toMatchObject({ _tag: "ServiceNotFoundError", service: "missing" });
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
    expect(selected.destroyCalls).toEqual([]);
  });

  test("does not apply or remove routes for a selected restart", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [redis.name] });

    await Effect.runPromise(selected.operation);

    expect(selected.applyRoutes).toEqual([]);
    expect(selected.removeRoutes).toEqual([]);
  });

  test("publishes pre-restart and post-restart with selected services and per-service stop events only for them", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [redis.name] });

    await Effect.runPromise(selected.operation);

    expect(byTag(selected.harness.events, "pre-restart")).toMatchObject([{ services: [redis.name] }]);
    expect(byTag(selected.harness.events, "post-restart")).toMatchObject([{ services: [redis.name] }]);
    expect(byTag(selected.harness.events, "pre-service-stop").map((event) => event.serviceName)).toEqual([
      redis.name,
    ]);
    expect(byTag(selected.harness.events, "post-service-stop").map((event) => event.serviceName)).toEqual([
      redis.name,
    ]);
    expect(byTag(selected.harness.events, "pre-stop")).toEqual([]);
    expect(byTag(selected.harness.events, "pre-start")).toEqual([]);
    expect(byTag(selected.harness.events, "pre-app-stop")).toEqual([]);
  });

  test.each([
    { selectedService: redis.name, acceleratedSibling: false },
    { selectedService: web.name, acceleratedSibling: false },
    { selectedService: redis.name, acceleratedSibling: true },
  ])(
    "file-sync sessions survive a selected container stop and start (%j)",
    async ({ selectedService, acceleratedSibling }) => {
      const redisPlan = withAcceleratedBind(twoServicePlan(), redis.name, {
        type: "bind",
        source: AbsolutePath.make(`${plan.root}/data`),
        target: PortablePath.make("/data"),
        readOnly: false,
        realization: "accelerated",
        mountKey: "data",
        excludes: [],
      });
      const plannedApp = acceleratedSibling
        ? withAcceleratedBind(redisPlan, web.name, {
            type: "bind",
            source: plan.root,
            target: PortablePath.make("/app"),
            readOnly: false,
            realization: "accelerated",
            mountKey: "app-mount",
            excludes: [],
          })
        : redisPlan;
      const sessions: FileSyncSessionInfo[] = plannedApp.fileSync.map(({ session }) => ({
        ref: FileSyncSessionRef.make(`sess-${session.service}`),
        app: session.app,
        service: session.service,
        mountKey: session.mountKey,
        spec: session,
        status: "running",
        lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
      }));
      const terminated: string[] = [];
      const flushed: string[] = [];
      const selected = runSelected(plannedApp, {
        services: [selectedService],
        appliedFileSyncState: "accelerated",
        fileSync: {
          ...TestFileSyncEngine,
          id: "mutagen",
          sessionsPersistAcrossProcesses: true,
          isAvailable: Effect.succeed(true),
          listSessions: (filter) =>
            Effect.succeed(
              sessions.filter(
                (session) =>
                  (filter.service === undefined || session.service === filter.service) &&
                  (filter.mountKey === undefined || session.mountKey === filter.mountKey),
              ),
            ),
          createSession: () => Effect.die("Selected restart must preserve existing sessions"),
          flushSession: (ref) =>
            Effect.sync(() => {
              flushed.push(String(ref));
            }),
          terminateSession: (ref) =>
            Effect.sync(() => {
              terminated.push(String(ref));
            }),
        },
      });

      await Effect.runPromise(selected.operation);

      expect(terminated).toEqual([]);
      expect(flushed).toEqual(selectedService === redis.name ? ["sess-redis"] : []);
      expect(selected.stopCalls).toEqual([selectedService]);
      expect(selected.destroyCalls).toEqual([]);
      expect(selected.applyCalls[0]?.options.recordedPlan?.fileSync).toEqual(plannedApp.fileSync);
    },
  );
});
