import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RouterService, type RuntimeProviderShape, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService } from "@lando/sdk/test";
import { Cause, DateTime, Effect, Exit, Option } from "effect";

import {
  beginOrResumeAcceleratedStart,
  readJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import type { PendingStart } from "../../src/operations/accelerated-start-record.ts";
import { infoForPlan } from "../../src/operations/info.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { selectedStopRefusal } from "../../src/operations/stop-selection.ts";
import { layerUnavailable } from "../../src/subsystems/proxy/api.ts";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/ssh/intent.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";
import { writeAgentRelayWorker, writeHostProxyWorker } from "./start-worker-retirement-support.ts";

const redis: ServicePlan = {
  ...web,
  name: ServiceName.make("redis"),
  type: "redis",
  primary: false,
  command: ["redis-server"],
  endpoints: [
    {
      kind: "published",
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
  command: ["worker"],
  endpoints: [],
};

const route = {
  hostname: "web.test",
  scheme: "http" as const,
  service: web.name,
  priority: 2,
  backend: { service: web.name, port: 3000, protocol: "http" as const },
};

const twoServicePlan = (): AppPlan => ({
  ...plan,
  routes: [route],
  services: {
    [web.name]: {
      ...web,
      routes: [{ index: 0 }],
      dependsOn: [{ service: redis.name, condition: "service_started", required: true }],
    },
    [redis.name]: redis,
  },
});

/** Two planned services whose selected start does not close over the other. */
const independentServicePlan = (): AppPlan => ({
  ...plan,
  routes: [route],
  services: {
    [web.name]: { ...web, routes: [{ index: 0 }] },
    [worker.name]: worker,
  },
});

const runtimeFor = (plannedApp: AppPlan, service: ServiceName): ServiceRuntimeInfo => ({
  app: plannedApp.id,
  appRoot: plannedApp.identity?.appRoot ?? plannedApp.root,
  service,
  providerId: plannedApp.provider,
  status: "running",
  containerId: `cid-${String(service)}`,
  publications: {
    status: "present",
    bindings:
      service === redis.name
        ? [{ port: 6379, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 34567 }]
        : [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
  },
  labels: {
    "dev.lando.app": plannedApp.id,
    "dev.lando.app-root": plannedApp.identity?.appRoot ?? plannedApp.root,
    "dev.lando.service": service,
  },
});

const sessionFor = (plannedApp: AppPlan, service: ServiceName): FileSyncSessionInfo => ({
  ref: FileSyncSessionRef.make(`${String(service)}-app-mount`),
  app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
  service,
  mountKey: "app-mount",
  spec: {
    app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    service,
    mountKey: "app-mount",
    source: plannedApp.root,
    target: { _tag: "volume", name: `${String(service)}-app-mount`, path: PortablePath.make("/app") },
    mode: "two-way-safe",
    excludes: [],
  },
  status: "running",
  lastUpdatedAt: DateTime.makeUnsafe("2026-09-23T00:00:00Z"),
});

const removeHarness = (harness: ReturnType<typeof makeHarness>) =>
  rm(harness.userDataRoot, { recursive: true, force: true });

const fileSyncHarness = (
  kind: "durable" | "terminate",
  sessions: Map<FileSyncSessionInfo["ref"], FileSyncSessionInfo>,
  calls: { readonly paused?: string[]; readonly terminated?: string[]; readonly drained?: string[] },
) => ({
  ...TestFileSyncEngine,
  id: "mutagen",
  isAvailable: Effect.succeed(true),
  listSessions: () => Effect.sync(() => [...sessions.values()]),
  flushSession: () => Effect.void,
  pauseSession: (ref: FileSyncSessionInfo["ref"]) =>
    Effect.sync(() => {
      calls.paused?.push(String(ref));
      const current = sessions.get(ref);
      if (current !== undefined) sessions.set(ref, { ...current, status: "paused" });
    }),
  terminateSession: (ref: FileSyncSessionInfo["ref"]) =>
    Effect.sync(() => {
      calls.terminated?.push(String(ref));
      sessions.delete(ref);
    }),
  ...(kind === "durable"
    ? {
        appLifecycle: {
          invalidateDrain: () => Effect.void,
          drain: (app: { readonly id: string }) =>
            Effect.sync(() => {
              calls.drained?.push(String(app.id));
            }),
          dispose: () => Effect.void,
          completeDisposal: () => Effect.void,
          disposalPhase: () => Effect.succeed("active" as const),
        },
      }
    : {}),
});

const runSelectedStop = (
  plannedApp: AppPlan,
  options: Parameters<typeof makeHarness>[0] & {
    readonly services: ReadonlyArray<ServiceName>;
    readonly containers?: Map<string, ServiceRuntimeInfo>;
    /** Runs after the provider reports containers, before the operation removes any. */
    readonly onList?: () => void;
  },
) => {
  const destroyCalls: unknown[] = [];
  const removed: string[] = [];
  const published: string[][] = [];
  const containers =
    options.containers ??
    new Map(
      Object.values(plannedApp.services).map((service) => [
        String(service.name),
        runtimeFor(plannedApp, service.name),
      ]),
    );
  const volumes = [{ name: "data", scope: "data" as const }];
  const { services: _services, containers: _seed, onList: _onList, ...harnessOptions } = options;
  const providerOverrides: Partial<RuntimeProviderShape> = {
    ...options.providerOverrides,
    list: () =>
      Effect.sync(() => {
        const rows = [...containers.values()];
        options.onList?.();
        return rows;
      }),
    removeObservedService: (observed) =>
      Effect.sync(() => {
        const current = containers.get(String(observed.service));
        if (observed.containerId === undefined || current?.containerId !== observed.containerId)
          return { kind: "absent" as const };
        containers.delete(String(observed.service));
        removed.push(String(observed.service));
        return { kind: "removed" as const };
      }),
  };
  const harness = makeHarness({
    ...harnessOptions,
    plannedApp,
    inspect:
      options.inspect ??
      ((target) => {
        const current = containers.get(String(target.service));
        return current === undefined
          ? Effect.succeed({
              app: plannedApp.id,
              service: target.service,
              providerId: plannedApp.provider,
              status: "absent" as const,
              publications: { status: "missing" as const },
            })
          : Effect.succeed(current);
      }),
    onApply: (applied) => {
      for (const service of Object.values(applied.services)) {
        if (!containers.has(String(service.name)))
          containers.set(String(service.name), runtimeFor(applied, service.name));
      }
      options.onApply?.(applied);
    },
    onDestroy: (...args) => {
      destroyCalls.push(args);
      options.onDestroy?.(...args);
    },
    onRemoveRoutes: () => {
      published.push(["withdrawn"]);
      options.onRemoveRoutes?.();
    },
    providerOverrides,
  });
  const target = {
    plan: plannedApp,
    root: plannedApp.root,
    app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
  };
  return {
    harness,
    containers,
    destroyCalls,
    removed,
    published,
    volumes,
    target,
    stop: (services: ReadonlyArray<ServiceName> = options.services) =>
      stopAppForTarget({ services }, target).pipe(Effect.provide(harness.layer)),
  };
};

describe("selected app stop", () => {
  test("keeps sibling containers, named volumes, and applied state", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    try {
      const result = await Effect.runPromise(selected.stop());
      expect(result).toMatchObject({
        outcome: "stopped",
        servicesStopped: ["redis"],
        servicesKeptRunning: ["web"],
      });
      expect(selected.removed).toEqual(["redis"]);
      expect(selected.containers.has("web")).toBe(true);
      expect(selected.containers.has("redis")).toBe(false);
      expect(selected.destroyCalls).toEqual([]);
      expect(selected.volumes).toEqual([{ name: "data", scope: "data" }]);
      const applied = await Effect.runPromise(
        selected.harness.runtimeProviderRegistry
          .resolveAppliedPlan(plannedApp.root)
          .pipe(Effect.provide(selected.harness.layer)),
      );
      expect(applied?.id).toBe(plannedApp.id);
      expect(Object.keys(applied?.services ?? {})).toEqual(expect.arrayContaining(["web", "redis"]));
      expect(byTag(selected.harness.events, "pre-app-stop")).toEqual([]);
      expect(byTag(selected.harness.events, "post-app-stop")).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("does not drain sibling file-sync sessions or terminate a durable engine", async () => {
    const plannedApp = twoServicePlan();
    const webSession = sessionFor(plannedApp, web.name);
    const redisSession = sessionFor(plannedApp, redis.name);
    const sessions = new Map([
      [webSession.ref, webSession],
      [redisSession.ref, redisSession],
    ]);
    const drained: string[] = [];
    const paused: string[] = [];
    const terminated: string[] = [];
    const selected = runSelectedStop(plannedApp, {
      services: [redis.name],
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [webSession.spec, redisSession.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.sync(() => [...sessions.values()]),
        flushSession: () => Effect.void,
        pauseSession: (ref) =>
          Effect.sync(() => {
            paused.push(String(ref));
            const current = sessions.get(ref);
            if (current !== undefined) sessions.set(ref, { ...current, status: "paused" });
          }),
        terminateSession: (ref) =>
          Effect.sync(() => {
            terminated.push(String(ref));
            sessions.delete(ref);
          }),
        appLifecycle: {
          invalidateDrain: () => Effect.void,
          drain: (app) =>
            Effect.sync(() => {
              drained.push(String(app.id));
            }),
          dispose: () => Effect.void,
          completeDisposal: () => Effect.void,
          disposalPhase: () => Effect.succeed("active" as const),
        },
      },
    });
    try {
      await Effect.runPromise(selected.stop());
      expect(drained).toEqual([]);
      expect(terminated).toEqual([]);
      expect(paused).toEqual([String(redisSession.ref)]);
      expect(sessions.get(webSession.ref)?.status).toBe("running");
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("retires a shared worker only when its last user stops", async () => {
    const plannedApp: AppPlan = {
      ...twoServicePlan(),
      services: {
        [web.name]: {
          ...web,
          routes: [{ index: 0 }],
          extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "sidecar" } },
        },
        [redis.name]: {
          ...redis,
          extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "sidecar" } },
        },
      },
    };
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    const app = { kind: "user" as const, id: plannedApp.id, root: plannedApp.root };
    const recordPath = await writeAgentRelayWorker(selected.harness, app, "ssh");
    try {
      expect(await Bun.file(recordPath).exists()).toBe(true);
      await Effect.runPromise(selected.stop([redis.name]));
      expect(await Bun.file(recordPath).exists()).toBe(true);
      await Effect.runPromise(selected.stop([web.name]));
      expect(await Bun.file(recordPath).exists()).toBe(false);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("leaves a host-proxy worker in place while a sibling still uses it", async () => {
    const plannedApp: AppPlan = {
      ...twoServicePlan(),
      services: {
        [web.name]: {
          ...web,
          routes: [{ index: 0 }],
          extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
        },
        [redis.name]: redis,
      },
    };
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    const app = { kind: "user" as const, id: plannedApp.id, root: plannedApp.root };
    const recordPath = await writeHostProxyWorker(selected.harness, app);
    try {
      expect(await Bun.file(recordPath).exists()).toBe(true);
      await Effect.runPromise(selected.stop());
      expect(await Bun.file(recordPath).exists()).toBe(true);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("warns when a still-running service depends on a stopped one", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    try {
      await Effect.runPromise(selected.stop());
      expect(byTag(selected.harness.events, "message.warn").map((event) => event.body)).toEqual([
        "web is still running and depends on redis, which was stopped.",
      ]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("rejects unknown and empty names before mutation", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    try {
      const unknown = await Effect.runPromiseExit(
        stopAppForTarget({ services: [ServiceName.make("typo")] }, selected.target).pipe(
          Effect.provide(selected.harness.layer),
        ),
      );
      const empty = await Effect.runPromiseExit(
        stopAppForTarget({ services: [ServiceName.make("")] }, selected.target).pipe(
          Effect.provide(selected.harness.layer),
        ),
      );
      expect(Exit.isFailure(unknown)).toBe(true);
      expect(Exit.isFailure(empty)).toBe(true);
      if (Exit.isFailure(unknown)) {
        const error = unknown.cause;
        expect(String(error)).toContain("ServiceNotFoundError");
      }
      expect(selected.removed).toEqual([]);
      expect(selected.destroyCalls).toEqual([]);
      expect(selected.containers.size).toBe(2);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("a later bare start restores the stopped services without touching running siblings", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    try {
      await Effect.runPromise(selected.stop());
      const webId = selected.containers.get("web")?.containerId;
      await Effect.runPromise(startApp({}, selected.target).pipe(Effect.provide(selected.harness.layer)));
      expect(selected.containers.get("web")?.containerId).toBe(webId);
      expect(selected.containers.get("redis")?.status).toBe("running");
      expect(selected.destroyCalls).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("a following selected start reports the stopped worker as stayed down", async () => {
    const plannedApp = independentServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [worker.name] });
    try {
      await Effect.runPromise(selected.stop());
      const started = await Effect.runPromise(
        startApp({ services: [web.name] }, selected.target).pipe(Effect.provide(selected.harness.layer)),
      );
      expect(started.servicesStayedDown).toEqual(["worker"]);
      const info = await Effect.runPromise(
        infoForPlan(plannedApp).pipe(Effect.provide(selected.harness.layer)),
      );
      expect(info.services.find((service) => service.service === "worker")?.status).toBe("stopped");
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("a following selected start publishes no route for the service selected stop took down (#2648)", async () => {
    const workerRoute = {
      ...route,
      hostname: "worker.test",
      service: worker.name,
      backend: { ...route.backend, service: worker.name },
    };
    const base = independentServicePlan();
    const plannedApp: AppPlan = {
      ...base,
      routes: [route, workerRoute],
      services: { ...base.services, [worker.name]: { ...worker, routes: [{ index: 1 }] } },
    };
    const selected = runSelectedStop(plannedApp, { services: [worker.name] });
    const published: string[][] = [];
    try {
      await Effect.runPromise(selected.stop());
      await Effect.runPromise(
        startApp({ services: [web.name] }, selected.target).pipe(
          Effect.provideService(RouterService, {
            ...TestRouterService,
            applyRoutes: (routes, owner) =>
              Effect.sync(() => void published.push(routes.map(({ hostname }) => hostname))).pipe(
                Effect.andThen(TestRouterService.applyRoutes(routes, owner)),
              ),
          }),
          Effect.provide(selected.harness.layer),
        ),
      );
      expect(published).toEqual([["web.test"]]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  for (const [scope, selection] of [
    ["inside", web.name],
    ["outside", redis.name],
  ] as const) {
    test(`refuses selected stop while an accelerated start's scope is ${scope} the selection`, async () => {
      const plannedApp: AppPlan = {
        ...acceleratedPlan,
        routes: [route],
        services: { ...acceleratedPlan.services, [redis.name]: redis },
      };
      const selected = runSelectedStop(plannedApp, { services: [selection] });
      try {
        await Effect.runPromise(
          beginOrResumeAcceleratedStart(plannedApp, selected.target.app, [web.name]).pipe(
            Effect.provide(selected.harness.layer),
          ),
        );
        const exit = await Effect.runPromiseExit(selected.stop());
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
          expect(error._tag).toBe("FileSyncStopError");
          expect("remediation" in error ? String(error.remediation) : "").toContain("lando start -s web");
        }
        expect(selected.removed).toEqual([]);
        expect(selected.containers.size).toBe(2);
        const journal = await Effect.runPromise(
          readJournal(selected.target.app).pipe(Effect.provide(selected.harness.layer)),
        );
        expect(journal.pending).toMatchObject({ services: ["web"], phase: "preparing" });
      } finally {
        await removeHarness(selected.harness);
      }
    });
  }

  test("does not report a selected service whose container vanished before removal", async () => {
    const plannedApp = twoServicePlan();
    const containers = new Map(
      Object.values(plannedApp.services).map((service) => [
        String(service.name),
        runtimeFor(plannedApp, service.name),
      ]),
    );
    const selected = runSelectedStop(plannedApp, {
      services: [redis.name],
      containers,
      onList: () => containers.delete("redis"),
    });
    try {
      const result = await Effect.runPromise(selected.stop());
      expect(result.outcome).toBe("unchanged");
      expect(result.servicesStopped).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("warns when selected stop cannot republish routes without a router", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [web.name] });
    try {
      await Effect.runPromise(
        stopAppForTarget({ services: [web.name] }, selected.target).pipe(
          Effect.provide(layerUnavailable),
          Effect.provide(selected.harness.layer),
        ),
      );
      expect(
        byTag(selected.harness.events, "message.warn").some((event) =>
          event.body.includes("because no router is available"),
        ),
      ).toBe(true);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("rejects file-sync coverage failure before removing containers", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, {
      services: [redis.name],
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [sessionFor(plannedApp, redis.name).spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
      },
    });
    try {
      const result = await Effect.runPromise(selected.stop().pipe(Effect.result));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "FileSyncStopError", engineId: "mutagen" },
      });
      expect(selected.removed).toEqual([]);
      expect(selected.containers.has("redis")).toBe(true);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("fails closed on unverifiable file-sync state before removing containers", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name], appliedFileSyncState: "unknown" });
    try {
      const result = await Effect.runPromise(selected.stop().pipe(Effect.result));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FileSyncStopError" } });
      expect(selected.removed).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test.each([
    ["an unrecorded", "extra"],
    ["a paused", "paused"],
  ] as const)("rejects %s session of a selected service before removing containers", async (_label, kind) => {
    const plannedApp = twoServicePlan();
    const redisSession = sessionFor(plannedApp, redis.name);
    const listed =
      kind === "extra"
        ? [
            redisSession,
            {
              ...redisSession,
              ref: FileSyncSessionRef.make("redis-cache"),
              mountKey: "cache",
              spec: { ...redisSession.spec, mountKey: "cache" },
            },
          ]
        : [{ ...redisSession, status: "paused" as const }];
    const flushed: string[] = [];
    const selected = runSelectedStop(plannedApp, {
      services: [redis.name],
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [redisSession.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed(listed),
        flushSession: (ref) => Effect.sync(() => void flushed.push(String(ref))),
      },
    });
    try {
      const result = await Effect.runPromise(selected.stop().pipe(Effect.result));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FileSyncStopError" } });
      expect(selected.removed).toEqual([]);
      expect(flushed).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("publishes no routes for an app with routing disabled", async () => {
    const plannedApp: AppPlan = { ...twoServicePlan(), router: { enabled: false } };
    let applied = 0;
    const selected = runSelectedStop(plannedApp, {
      services: [web.name],
      afterApplyRoutes: Effect.sync(() => {
        applied += 1;
      }),
    });
    try {
      const result = await Effect.runPromise(selected.stop());
      expect(result.servicesStopped).toEqual(["web"]);
      expect(applied).toBe(0);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("without an applied record, changes nothing or refuses the app's leftover containers", async () => {
    const plannedApp = twoServicePlan();
    let applied = 0;
    const fresh = runSelectedStop(plannedApp, {
      services: [redis.name],
      appliedPlans: [],
      containers: new Map(),
      afterApplyRoutes: Effect.sync(() => {
        applied += 1;
      }),
    });
    const leftover = runSelectedStop(plannedApp, { services: [redis.name], appliedPlans: [] });
    try {
      expect(await Effect.runPromise(fresh.stop())).toMatchObject({
        outcome: "unchanged",
        servicesStopped: [],
        servicesKeptRunning: [],
      });
      expect(applied).toBe(0);
      const refused = await Effect.runPromise(leftover.stop().pipe(Effect.result));
      expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "AppResolveError" } });
      expect(leftover.removed).toEqual([]);
    } finally {
      await removeHarness(fresh.harness);
      await removeHarness(leftover.harness);
    }
  });

  test("brackets each selected service's removal with its own stop events", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [web.name, redis.name] });
    try {
      await Effect.runPromise(selected.stop());
      const order = selected.harness.events.flatMap((event) =>
        event._tag === "pre-service-stop" || event._tag === "post-service-stop"
          ? [`${event._tag}:${String(event.serviceName)}`]
          : [],
      );
      expect(order).toEqual([
        "pre-service-stop:redis",
        "post-service-stop:redis",
        "pre-service-stop:web",
        "post-service-stop:web",
      ]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("does not report or warn about a paused sibling as still running", async () => {
    const plannedApp = twoServicePlan();
    const {
      health: _health,
      healthCheckedAt: _healthCheckedAt,
      exitCode: _exitCode,
      ...webRuntime
    } = runtimeFor(plannedApp, web.name);
    const containers = new Map<string, ServiceRuntimeInfo>([
      ["web", { ...webRuntime, status: "paused" }],
      ["redis", runtimeFor(plannedApp, redis.name)],
    ]);
    const selected = runSelectedStop(plannedApp, { services: [redis.name], containers });
    try {
      const result = await Effect.runPromise(selected.stop());
      expect(result).toMatchObject({ servicesStopped: ["redis"], servicesKeptRunning: [] });
      expect(byTag(selected.harness.events, "message.warn")).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test("skips stop events for a selected service that has no container", async () => {
    const plannedApp = twoServicePlan();
    const containers = new Map([["web", runtimeFor(plannedApp, web.name)]]);
    const selected = runSelectedStop(plannedApp, { services: [redis.name], containers });
    try {
      const result = await Effect.runPromise(selected.stop());
      expect(result.outcome).toBe("unchanged");
      expect(result.servicesStopped).toEqual([]);
      expect(result.servicesKeptRunning).toEqual(["web"]);
      expect(byTag(selected.harness.events, "pre-service-stop")).toEqual([]);
      expect(byTag(selected.harness.events, "post-service-stop")).toEqual([]);
    } finally {
      await removeHarness(selected.harness);
    }
  });

  test.each(["durable", "terminate"] as const)(
    "a second selected stop is a no-op on a %s file-sync engine",
    async (kind) => {
      const plannedApp = twoServicePlan();
      const webSession = sessionFor(plannedApp, web.name);
      const redisSession = sessionFor(plannedApp, redis.name);
      const sessions = new Map([
        [webSession.ref, webSession],
        [redisSession.ref, redisSession],
      ]);
      const paused: string[] = [];
      const terminated: string[] = [];
      const selected = runSelectedStop(plannedApp, {
        services: [redis.name],
        appliedFileSyncState: "accelerated",
        appliedFileSyncSessions: [webSession.spec, redisSession.spec],
        fileSync: fileSyncHarness(kind, sessions, { paused, terminated }),
      });
      try {
        const first = await Effect.runPromise(selected.stop());
        expect(first.outcome).toBe("stopped");
        const second = await Effect.runPromise(selected.stop());
        expect(second).toMatchObject({
          outcome: "unchanged",
          servicesStopped: [],
          servicesKeptRunning: ["web"],
        });
        if (kind === "durable") expect(paused).toEqual([String(redisSession.ref)]);
        else expect(terminated).toEqual([String(redisSession.ref)]);
      } finally {
        await removeHarness(selected.harness);
      }
    },
  );

  test.each(["durable", "terminate"] as const)(
    "a later bare stop succeeds after selected stop on a %s file-sync engine",
    async (kind) => {
      const plannedApp = twoServicePlan();
      const webSession = sessionFor(plannedApp, web.name);
      const redisSession = sessionFor(plannedApp, redis.name);
      const sessions = new Map([
        [webSession.ref, webSession],
        [redisSession.ref, redisSession],
      ]);
      const drained: string[] = [];
      const paused: string[] = [];
      const terminated: string[] = [];
      const selected = runSelectedStop(plannedApp, {
        services: [redis.name],
        appliedFileSyncState: "accelerated",
        appliedFileSyncSessions: [webSession.spec, redisSession.spec],
        fileSync: fileSyncHarness(kind, sessions, { paused, terminated, drained }),
      });
      try {
        await Effect.runPromise(selected.stop());
        const result = await Effect.runPromise(
          stopAppForTarget({}, selected.target).pipe(Effect.provide(selected.harness.layer)),
        );
        expect(result.outcome).toBe("stopped");
        if (kind === "durable") {
          expect(paused).toEqual([String(redisSession.ref)]);
          expect(drained).toEqual([String(plannedApp.id)]);
          expect(terminated).toEqual([]);
        } else {
          expect(terminated).toEqual([String(redisSession.ref), String(webSession.ref)]);
          expect(drained).toEqual([]);
        }
      } finally {
        await removeHarness(selected.harness);
      }
    },
  );

  test("info after a selected stop reports the stopped service as stopped", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelectedStop(plannedApp, { services: [redis.name] });
    try {
      await Effect.runPromise(selected.stop());
      const info = await Effect.runPromise(
        infoForPlan(plannedApp).pipe(Effect.provide(selected.harness.layer)),
      );
      expect(info.services.find((service) => service.service === "web")?.status).toBe("running");
      expect(info.services.find((service) => service.service === "redis")?.status).toBe("stopped");
    } finally {
      await removeHarness(selected.harness);
    }
  });
});

describe("selected stop refusal", () => {
  const journal: PendingStart = {
    attemptId: "attempt",
    appId: "demo",
    appRoot: "/apps/demo",
    providerId: "lando",
    engineId: "mutagen",
    mountPlanDigest: "digest",
    services: [web.name],
    phase: "preparing",
    targets: [],
    sessions: [],
  };
  test.each([
    { journalOpen: true, rootExists: true, record: "applied", refusal: "FileSyncStopError" },
    { journalOpen: true, rootExists: false, record: "applied", refusal: "FileSyncStopError" },
    { journalOpen: true, rootExists: true, record: "unrecorded", refusal: "FileSyncStopError" },
    { journalOpen: true, rootExists: false, record: "none", refusal: "FileSyncStopError" },
    { journalOpen: false, rootExists: false, record: "applied", refusal: "AppResolveError" },
    { journalOpen: false, rootExists: false, record: "none", refusal: "AppResolveError" },
    { journalOpen: false, rootExists: true, record: "unrecorded", refusal: "AppResolveError" },
    { journalOpen: false, rootExists: true, record: "applied", refusal: undefined },
    { journalOpen: false, rootExists: true, record: "none", refusal: undefined },
  ] as const)(
    "journal open $journalOpen, root exists $rootExists, record $record: $refusal",
    ({ journalOpen, rootExists, record, refusal }) => {
      const error = selectedStopRefusal({ journal: journalOpen ? journal : undefined, rootExists, record });
      expect(error?._tag).toBe(refusal);
      if (error?._tag === "FileSyncStopError") expect(error.remediation).toContain("`lando start -s web`");
    },
  );
});

test("library stop rejects an empty service name with ServiceNotFoundError", async () => {
  const plannedApp = twoServicePlan();
  const selected = runSelectedStop(plannedApp, { services: [redis.name] });
  try {
    const result = await Effect.runPromise(
      stopAppForTarget({ services: [ServiceName.make("")] }, selected.target).pipe(
        Effect.provide(selected.harness.layer),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ServiceNotFoundError", service: "" },
    });
    expect(selected.removed).toEqual([]);
  } finally {
    await removeHarness(selected.harness);
  }
});
