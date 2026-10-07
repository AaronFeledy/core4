import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ServiceNotFoundError, ServiceRestartWouldRecreateError } from "@lando/sdk/errors";
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
  endpoints: (plannedApp.services[service]?.endpoints ?? []).map((endpoint) =>
    endpoint._tag === "published" && endpoint.publication.hostPort === undefined
      ? {
          ...endpoint,
          materialization: { bindAddress: "127.0.0.1", hostPort: 34567 },
        }
      : endpoint,
  ),
  ...extras,
});

const runSelected = (
  plannedApp: AppPlan,
  options: Parameters<typeof makeHarness>[0] & {
    readonly services?: ReadonlyArray<ServiceName>;
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
  const operation = restartApp(options.services === undefined ? {} : { services: options.services }, {
    plan: plannedApp,
    root: plannedApp.root,
    app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
  }).pipe(
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
    const redisHttp = selected.runtimes
      .get("redis")
      ?.endpoints?.find((endpoint) => endpoint._tag === "published");
    expect(
      redisHttp && "materialization" in redisHttp ? redisHttp.materialization?.hostPort : undefined,
    ).toBe(34567);
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

  test("file-sync sessions survive a selected container stop and start", async () => {
    const session: FileSyncSessionInfo = {
      ref: FileSyncSessionRef.make("sess-redis"),
      app: { kind: "user", id: plan.id, root: plan.root },
      service: redis.name,
      mountKey: "data",
      spec: {
        app: { kind: "user", id: plan.id, root: plan.root },
        service: redis.name,
        mountKey: "data",
        source: AbsolutePath.make(`${plan.root}/data`),
        target: { _tag: "volume", name: "redis-data", path: PortablePath.make("/data") },
        mode: "two-way-safe",
        excludes: [],
      },
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
    };
    const terminated: string[] = [];
    const flushed: string[] = [];
    const plannedApp: AppPlan = {
      ...twoServicePlan(),
      fileSync: [{ engineId: "mutagen", session: session.spec }],
    };
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
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
    expect(flushed).toEqual(["sess-redis"]);
    expect(selected.stopCalls).toEqual([redis.name]);
    expect(selected.destroyCalls).toEqual([]);
  });
});
