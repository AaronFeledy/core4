import { describe, expect, test } from "bun:test";
import { FileSyncStartError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  type ServiceContainerChange,
  ServiceName,
  type ServicePlan,
  type ServiceRunObservation,
} from "@lando/sdk/schema";
import type { ApplyOptions, ServiceRuntimeFields, ServiceRuntimeInfo } from "@lando/sdk/services";
import { RouterService } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService } from "@lando/sdk/test";
import { Cause, DateTime, Effect, Exit } from "effect";

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
    [web.name]: { ...web, routes: [{ index: 0 }] },
    [redis.name]: redis,
  },
});

const threeServicePlan = (): AppPlan => ({
  ...plan,
  services: { [web.name]: web, [redis.name]: redis, [worker.name]: worker },
});

const runtimeFor = (
  plannedApp: AppPlan,
  service: ServiceName,
  extras: Partial<ServiceRuntimeFields> | ServiceRunObservation = {},
): ServiceRuntimeInfo => ({
  app: plannedApp.id,
  service,
  providerId: plannedApp.provider,
  status: "running" as const,
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
    readonly afterApply?: (applied: AppPlan, runtimes: Map<string, ServiceRuntimeInfo>) => void;
    readonly buildResult?: (selected: AppPlan) => AppPlan;
    readonly containerChanges?: (applied: AppPlan) => Readonly<Record<string, ServiceContainerChange>>;
  } = {},
) => {
  const applyCalls: Array<{ readonly plan: AppPlan; readonly options: ApplyOptions }> = [];
  const buildCalls: Array<{ readonly plan: AppPlan; readonly refresh?: boolean }> = [];
  const appBuildCalls: Array<{ readonly plan: AppPlan; readonly force: boolean | undefined }> = [];
  const stopCalls: ServiceName[] = [];
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
    onBuild: (buildPlan, buildOptions) => {
      if (buildPlan.id !== plannedApp.id) return;
      buildCalls.push({
        plan: buildPlan,
        ...(buildOptions?.refresh === undefined ? {} : { refresh: buildOptions.refresh }),
      });
    },
    onBuildApp: (appPlan, appBuildOptions) => {
      appBuildCalls.push({ plan: appPlan, force: appBuildOptions?.force });
    },
    onApply: (applied, applyOptions) => {
      applyCalls.push({ plan: applied, options: applyOptions ?? { reconcile: false } });
      options.afterApply?.(applied, runtimes);
    },
    onStop: (target) => {
      stopCalls.push(target.service);
    },
    applyOutcome: (applied) => {
      const services = options.containerChanges?.(applied);
      return services === undefined ? undefined : { changed: true, services };
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
      applyRoutes: (routes, owner) =>
        Effect.sync(() => {
          applyRoutes.push(routes.length);
        }).pipe(Effect.andThen(TestRouterService.applyRoutes(routes, owner))),
      removeRoutes: (owner) => Effect.sync(() => void removeRoutes.push(owner.ownerKey)),
    }),
    Effect.provide(harness.layer),
  );
  return {
    harness,
    operation,
    applyCalls,
    buildCalls,
    appBuildCalls,
    stopCalls,
    applyRoutes,
    removeRoutes,
    runtimes,
  };
};

describe("selected service restart", () => {
  test("applies only the selected service with default build and reconciliation policies", async () => {
    // Given a started two-service app whose selected container is unchanged.
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [redis.name] });
    // When only redis is restarted.
    const result = await Effect.runPromise(selected.operation);
    // Then it stops and applies the one selected service without forcing recreation.
    expect(selected.stopCalls).toEqual([redis.name]);
    expect(selected.applyCalls).toHaveLength(1);
    expect(selected.applyCalls[0]?.options).toMatchObject({ reconcile: false });
    expect(selected.applyCalls[0]?.options.complete).toBeUndefined();
    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual([redis.name]);
    // The recorded plan keeps the full desired routes so the selected service's refs stay valid.
    expect(selected.applyCalls[0]?.options.recordedPlan?.routes).toEqual(plannedApp.routes);
    expect(Object.keys(selected.applyCalls[0]?.options.recordedPlan?.services ?? {})).toEqual([redis.name]);
    // The artifact build ran with the default cache policy and the app build was not forced.
    expect(selected.buildCalls).toHaveLength(1);
    expect(selected.buildCalls[0]?.refresh).toBeUndefined();
    expect(selected.appBuildCalls).toHaveLength(1);
    expect(selected.appBuildCalls[0]?.force).toBeUndefined();
    expect(Object.keys(selected.appBuildCalls[0]?.plan.services ?? {})).toEqual([redis.name]);
    // The container kept its identity and no replacement notice was published.
    expect(selected.runtimes.get("redis")?.containerId).toBe("cid-redis");
    expect(selected.runtimes.get("web")?.containerId).toBe("cid-web");
    expect(byTag(selected.harness.events, "message.info")).toEqual([]);
    expect(result.servicesStarted.map((service) => service.name)).toEqual([redis.name]);
  });

  test("announces a reported replacement without inspecting the container before apply", async () => {
    // Given the provider reports that apply replaced the selected container.
    const plannedApp = twoServicePlan();
    let applied = false;
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      containerChanges: () => ({ redis: { action: "replaced", reason: "config" } }),
      afterApply: () => {
        applied = true;
      },
      inspect: (target) => {
        if (!applied) throw new Error("selected restart inspected before apply");
        return Effect.succeed(runtimeFor(plannedApp, target.service));
      },
    });
    // When only redis is restarted.
    const result = await Effect.runPromise(selected.operation);
    // Then the replacement is announced from the apply result and the result carries it.
    expect(byTag(selected.harness.events, "message.info").map((event) => event.body)).toEqual([
      "Lando replaced redis's container because its configuration changed.",
    ]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "replaced", reason: "config" });
    expect(selected.applyCalls[0]?.options).toMatchObject({ reconcile: false });
    expect(selected.appBuildCalls.map(({ plan: appPlan }) => Object.keys(appPlan.services))).toEqual([
      ["redis"],
    ]);
    expect(selected.runtimes.get("web")?.containerId).toBe("cid-web");
  });

  test("names the anonymous volumes a reported replacement removed", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      containerChanges: () => ({
        redis: { action: "replaced", reason: "bind-source", anonymousVolumes: ["/data"] },
      }),
    });
    // When the restart runs.
    await Effect.runPromise(selected.operation);
    // Then the notice names the lost data and how to keep it.
    expect(byTag(selected.harness.events, "message.info").map((event) => event.body)).toEqual([
      "Lando replaced redis's container because a mounted host path changed. Its anonymous volume at /data went with it; declare that path under storage: to keep its data.",
    ]);
  });

  test("announces a reported creation of an absent selected container", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      containerChanges: () => ({ redis: { action: "created" } }),
    });
    // When the restart runs.
    const result = await Effect.runPromise(selected.operation);
    // Then it announces the creation from the apply result.
    expect(byTag(selected.harness.events, "message.info").map((event) => event.body)).toEqual([
      "redis had no container, so Lando created one.",
    ]);
    expect(result.servicesStarted[0]?.container).toEqual({ action: "created" });
  });

  test("publishes no notice when the provider reports no container outcomes", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      afterApply: (applied, runtimes) => {
        for (const service of Object.values(applied.services)) {
          const current = runtimes.get(String(service.name));
          if (current === undefined) continue;
          runtimes.set(String(service.name), {
            ...current,
            containerId: `recreated-${String(service.name)}`,
          });
        }
      },
    });
    // When the restart runs without a container report.
    const result = await Effect.runPromise(selected.operation);
    // Then observation changes alone prove nothing, and no container field is invented.
    expect(byTag(selected.harness.events, "message.info")).toEqual([]);
    expect(result.servicesStarted[0]?.container).toBeUndefined();
  });

  test("refuses without an applied plan before any stop, hook, or build", async () => {
    // Given no ownership-matched applied plan.
    const selected = runSelected(twoServicePlan(), {
      services: [redis.name],
      resolveAppliedPlan: () => Effect.succeed(undefined),
      appliedPlans: [],
    });
    // When a selected restart runs.
    const error = await Effect.runPromise(Effect.flip(selected.operation));
    // Then it refuses with the start remediation before doing anything.
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ _tag: "ProviderUnavailableError", operation: "restart" });
    expect(error.remediation).toContain("lando start");
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
    expect(selected.buildCalls).toEqual([]);
    expect(byTag(selected.harness.events, "pre-init")).toEqual([]);
    expect(byTag(selected.harness.events, "pre-restart")).toEqual([]);
    expect(byTag(selected.harness.events, "pre-service-stop")).toEqual([]);
  });

  test("refuses a new accelerated session before stopping", async () => {
    // Given a selected accelerated bind whose session the applied plan never prepared.
    const plannedApp = withAcceleratedBind(twoServicePlan(), redis.name, {
      type: "bind",
      source: AbsolutePath.make(`${plan.root}/data`),
      target: PortablePath.make("/data"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "data",
      excludes: [],
    });
    const applied = twoServicePlan();
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
      },
    });
    // When the restart preflights the accelerated bundle.
    const error = await Effect.runPromise(Effect.flip(selected.operation));
    // Then it refuses before any stop with file-sync remediation.
    expect(error).toBeInstanceOf(FileSyncStartError);
    expect(error.message).toContain("redis");
    expect(error.remediation).toContain("lando start");
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
  });

  test("refuses an accelerated session the applied record holds under another engine", async () => {
    // Given a selected accelerated bind whose applied session spec matches but names another engine.
    const mount = {
      type: "bind" as const,
      source: AbsolutePath.make(`${plan.root}/data`),
      target: PortablePath.make("/data"),
      readOnly: false,
      realization: "accelerated" as const,
      mountKey: "data",
      excludes: [],
    };
    const plannedApp = withAcceleratedBind(twoServicePlan(), redis.name, mount);
    const previous = withAcceleratedBind(twoServicePlan(), redis.name, mount);
    const applied: AppPlan = {
      ...previous,
      fileSync: previous.fileSync.map((entry) => ({ ...entry, engineId: "other-engine" })),
    };
    const selected = runSelected(plannedApp, {
      services: [redis.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
      },
    });
    // When the restart preflights the selected sessions.
    const error = await Effect.runPromise(Effect.flip(selected.operation));
    // Then it refuses before any stop, because only start switches the sync engine.
    expect(error).toBeInstanceOf(FileSyncStartError);
    expect(error.remediation).toContain("lando start");
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
  });

  test("refuses a removed accelerated session before stopping", async () => {
    // Given an applied accelerated bind that the desired plan turned back into an ordinary bind.
    const applied = withAcceleratedBind(twoServicePlan(), redis.name, {
      type: "bind",
      source: AbsolutePath.make(`${plan.root}/data`),
      target: PortablePath.make("/data"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "data",
      excludes: [],
    });
    const selected = runSelected(twoServicePlan(), {
      services: [redis.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
    });
    // When the restart preflights the selected sessions.
    const error = await Effect.runPromise(Effect.flip(selected.operation));
    // Then it refuses before any stop, because only start flushes and retires the sync target.
    expect(error).toBeInstanceOf(FileSyncStartError);
    expect(error.message).toContain("redis");
    expect(error.remediation).toContain("lando start");
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
  });

  test("leaves the selected services running when the artifact build fails", async () => {
    // Given a selected service whose artifact build fails.
    const selected = runSelected(twoServicePlan(), {
      services: [redis.name],
      buildResult: () => {
        throw new Error("artifact build failed");
      },
    });
    // When the restart builds before it stops anything.
    const exit = await Effect.runPromiseExit(selected.operation);
    // Then it fails without stopping or applying the service.
    expect(Exit.isFailure(exit)).toBe(true);
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

  test("stops multiple selected services in reverse plan order", async () => {
    const plannedApp = threeServicePlan();
    const selected = runSelected(plannedApp, { services: [web.name, worker.name] });

    const result = await Effect.runPromise(selected.operation);

    expect(selected.stopCalls).toEqual([worker.name, web.name]);
    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual(["web", "worker"]);
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["web", "worker"]);
    expect(selected.runtimes.get("redis")?.containerId).toBe("cid-redis");
  });

  test("unknown service fails with ServiceNotFoundError before provider action", async () => {
    const plannedApp = twoServicePlan();
    const selected = runSelected(plannedApp, { services: [ServiceName.make("missing")] });

    const error = await Effect.runPromise(Effect.flip(selected.operation));

    expect(error).toBeInstanceOf(ServiceNotFoundError);
    expect(error).toMatchObject({ _tag: "ServiceNotFoundError", service: "missing" });
    expect(selected.stopCalls).toEqual([]);
    expect(selected.applyCalls).toEqual([]);
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
      expect(selected.applyCalls[0]?.options.recordedPlan?.fileSync).toEqual(
        plannedApp.fileSync.filter(({ session }) => session.service === selectedService),
      );
    },
  );
});
