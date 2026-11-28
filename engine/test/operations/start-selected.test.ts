import { describe, expect, test } from "bun:test";
import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import { sameRealpath } from "@lando/paths";
import { FileSyncStartError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  PortablePath,
  ServiceName,
  type ServicePlan,
  hasStructuralFileSyncCoverage,
} from "@lando/sdk/schema";
import type { ApplyOptions, ListFilter, ServiceRuntimeFields, ServiceRuntimeInfo } from "@lando/sdk/services";
import { RouterService } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";

import {
  beginOrResumeAcceleratedStart,
  readPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { infoApp } from "../../src/operations/info.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { selectRebuildPlan } from "../../src/operations/service-selection.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { withAcceleratedBind } from "../accelerated-plan.ts";
import { publicUrlRouter } from "../lifecycle/route-url-fixture.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const db: ServicePlan = {
  ...web,
  name: ServiceName.make("db"),
  type: "postgres",
  primary: false,
  command: ["postgres"],
  endpoints: [],
};

const redis: ServicePlan = {
  ...web,
  name: ServiceName.make("redis"),
  type: "redis",
  primary: false,
  command: ["redis-server"],
  endpoints: [],
};

const webWithDb: ServicePlan = {
  ...web,
  dependsOn: [{ service: db.name, condition: "service_started", required: true }],
};

const threeServicePlan = (): AppPlan => ({
  ...plan,
  services: { [webWithDb.name]: webWithDb, [db.name]: db, [redis.name]: redis },
});

const acceleratedSiblingPlan = (): AppPlan => {
  const withRedis = withAcceleratedBind(threeServicePlan(), redis.name, {
    type: "bind",
    source: AbsolutePath.make(`${plan.root}/data`),
    target: PortablePath.make("/data"),
    readOnly: false,
    realization: "accelerated",
    mountKey: "data",
    excludes: [],
  });
  return withAcceleratedBind(withRedis, web.name, {
    type: "bind",
    source: plan.root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    mountKey: "app-mount",
    excludes: [],
  });
};

const durableMutagenEngine = () => ({
  ...TestFileSyncEngine,
  id: "mutagen",
  sessionsPersistAcrossProcesses: true,
  isAvailable: Effect.succeed(true),
  appLifecycle: {
    invalidateDrain: () => Effect.void,
    drain: () => Effect.void,
    dispose: () => Effect.void,
    completeDisposal: () => Effect.void,
    disposalPhase: () => Effect.succeed("active" as const),
  },
});

const runtimeFor = (
  plannedApp: AppPlan,
  service: ServiceName,
  extras: Partial<ServiceRuntimeFields> = {},
): Extract<ServiceRuntimeInfo, { status: "running" }> => ({
  app: plannedApp.id,
  appRoot: plannedApp.identity?.appRoot ?? plannedApp.root,
  service,
  providerId: plannedApp.provider,
  status: "running",
  containerId: `cid-${String(service)}`,
  publications: { status: "unknown" },
  ...extras,
});

const missingService = (plannedApp: AppPlan, service: ServiceName) =>
  new ServiceNotFoundError({
    providerId: String(plannedApp.provider),
    operation: "inspect",
    service: String(service),
    message: `Service ${String(service)} is not running.`,
    remediation: "Start the service.",
  });

const targetOf = (plannedApp: AppPlan) => ({
  plan: plannedApp,
  root: plannedApp.root,
  app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
});

const runStart = (
  plannedApp: AppPlan,
  options: Parameters<typeof makeHarness>[0] & {
    readonly services?: ReadonlyArray<ServiceName>;
    readonly afterApply?: (applied: AppPlan, applyOptions: ApplyOptions | undefined) => void;
    readonly router?: typeof TestRouterService;
  } = {},
) => {
  const applyCalls: Array<{ readonly plan: AppPlan; readonly options: ApplyOptions }> = [];
  const stopCalls: ServiceName[] = [];
  const removed: string[] = [];
  const prepared: AppPlan[] = [];
  const runtimes = new Map<string, ServiceRuntimeInfo>();
  const containers: ServiceRuntimeInfo[] = [];
  const { services, afterApply, router, ...harnessOptions } = options;
  const harness = makeHarness({
    plannedApp,
    ...harnessOptions,
    onPrepareFileSync: (syncPlan) => {
      prepared.push(syncPlan);
      options.onPrepareFileSync?.(syncPlan);
    },
    onApply: (applied, applyOptions) => {
      applyCalls.push({ plan: applied, options: applyOptions ?? { reconcile: false } });
      for (const service of Object.values(applied.services)) {
        const runtime = runtimeFor(plannedApp, service.name);
        runtimes.set(String(service.name), runtime);
        if (!containers.some((entry) => String(entry.service) === String(service.name)))
          containers.push(runtime);
      }
      options.afterApply?.(applied, applyOptions);
    },
    inspect:
      options.inspect ??
      ((target) => {
        const runtime = runtimes.get(String(target.service));
        return runtime === undefined
          ? Effect.fail(missingService(plannedApp, target.service))
          : Effect.succeed(runtime);
      }),
    providerOverrides: {
      list: (filter: ListFilter) =>
        Effect.succeed(containers.filter((entry) => filter.app === undefined || entry.app === filter.app)),
      bringDownObserved: (observation, disposition) =>
        Effect.sync(() => {
          if (disposition === "stop") {
            stopCalls.push(observation.service);
            options.onStop?.(observation);
            return { service: observation.service, action: "stopped" as const };
          }
          removed.push(String(observation.service));
          return { service: observation.service, action: "removed" as const };
        }),
      ...options.providerOverrides,
    },
  });
  const operation = startApp(
    {
      ...(services === undefined ? {} : { services }),
    },
    targetOf(plannedApp),
  ).pipe(Effect.provideService(RouterService, router ?? TestRouterService), Effect.provide(harness.layer));
  return { harness, operation, applyCalls, stopCalls, removed, prepared, runtimes, containers };
};

describe("selected service start route URLs", () => {
  const route = {
    hostname: "web.test",
    scheme: "http" as const,
    service: web.name,
    priority: 2,
    backend: { service: web.name, port: 3000, protocol: "http" as const },
  };
  const publicUrl = {
    PUBLIC_URL: { _tag: "RouteText" as const, parts: [{ service: web.name, encoding: "raw" as const }] },
  };
  const appliedApp = (consumer: ServicePlan = redis): AppPlan => ({
    ...plan,
    routes: [route],
    services: { [web.name]: { ...web, routes: [{ index: 0 }] }, [consumer.name]: consumer },
  });

  test("binds a selected consumer against the route the running app already published", async () => {
    const applied = appliedApp();
    const consumer = { ...redis, environment: publicUrl } satisfies ServicePlan;
    const desired: AppPlan = {
      ...applied,
      routes: [{ ...route, hostname: "web-new.test" }],
      services: { ...applied.services, [consumer.name]: consumer },
    };
    const selected = runStart(desired, {
      services: [redis.name],
      router: publicUrlRouter(),
      appliedPlans: [applied],
      resolveAppliedPlan: () => Effect.succeed(applied),
    });
    await Effect.runPromise(selected.operation);
    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual([redis.name]);
    expect(selected.applyCalls[0]?.plan.services[redis.name]?.environment.PUBLIC_URL).toBe(
      "http://web.test:8080",
    );
  });

  test.each([
    { member: undefined, prior: "http://web.test:8080", hostname: "web-new.test", refuses: true },
    { member: "publicPort", prior: "http://web.test:9080", hostname: "web.test", refuses: true },
    { member: "scheme", prior: "http://web.test:9080", hostname: "web.test", refuses: false },
  ] as const)("checks retained route facts before apply ($member, $prior)", async (row) => {
    const consumer = {
      ...redis,
      extensions: {
        ...redis.extensions,
        "@lando/engine/realized-route-urls": { web: row.prior },
      },
      environment: {
        PUBLIC_URL: {
          _tag: "RouteText",
          parts: [{ service: web.name, ...(row.member ? { member: row.member } : {}), encoding: "raw" }],
        },
      },
    } satisfies ServicePlan;
    const applied = appliedApp(consumer);
    const desired: AppPlan = { ...applied, routes: [{ ...route, hostname: row.hostname }] };
    const selected = runStart(desired, {
      services: [web.name],
      router: publicUrlRouter(),
      appliedPlans: [applied],
      resolveAppliedPlan: () => Effect.succeed(applied),
    });
    const result = await Effect.runPromise(selected.operation.pipe(Effect.result));
    if (!row.refuses) {
      expect(result._tag).toBe("Success");
      expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual([web.name]);
      return;
    }
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "RouteUrlBindingError",
        reason: "retained-consumer",
        service: web.name,
        consumers: [redis.name],
      },
    });
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        remediation: expect.stringContaining("lando start --service web --service redis"),
      });
    expect(selected.applyCalls).toEqual([]);
  });
});

describe("selected service start", () => {
  test("starts the named service and its prerequisites", async () => {
    const plannedApp = threeServicePlan();
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(undefined),
    });

    const result = await Effect.runPromise(selected.operation);

    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual(["db", "web"]);
    expect(selected.applyCalls[0]?.options.complete).toBeUndefined();
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["db", "web"]);
    expect(result.servicesStayedDown).toEqual(["redis"]);
    expect(selected.stopCalls).toEqual([]);
    expect(
      selected.harness.events.flatMap((event): string[][] => {
        switch (event._tag) {
          case "pre-app-start":
          case "post-app-start":
            return [[event._tag]];
          case "pre-start":
          case "post-start":
            return [[event._tag, ...(event.services ?? [])]];
          default:
            return [];
        }
      }),
    ).toEqual([
      ["pre-app-start"],
      ["pre-start", "db", "web"],
      ["post-app-start"],
      ["post-start", "db", "web"],
    ]);
  });

  test("leaves unselected running siblings alone", async () => {
    const plannedApp = threeServicePlan();
    const selected = runStart(plannedApp, { services: [web.name] });
    selected.runtimes.set("redis", runtimeFor(plannedApp, redis.name));
    selected.containers.push(runtimeFor(plannedApp, redis.name));

    const result = await Effect.runPromise(selected.operation);

    expect(Object.keys(selected.applyCalls[0]?.plan.services ?? {})).toEqual(["db", "web"]);
    expect(selected.applyCalls[0]?.options.complete).toBeUndefined();
    expect(selected.stopCalls).toEqual([]);
    expect(selected.removed).toEqual([]);
    expect(selected.runtimes.get("redis")?.containerId).toBe("cid-redis");
    expect(result.servicesStayedDown).toBeUndefined();
  });

  test("records only applied services on a first selected start", async () => {
    const plannedApp = threeServicePlan();
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(undefined),
    });

    await Effect.runPromise(selected.operation);

    const recorded = selected.applyCalls[0]?.options.recordedPlan;
    expect(Object.keys(recorded?.services ?? {}).sort()).toEqual(["db", "web"]);
    expect(recorded?.fileSync).toEqual([]);
  });

  test("a later whole-app start creates the rest without touching running services", async () => {
    const plannedApp = threeServicePlan();
    let applied: AppPlan | undefined;
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      afterApply: (_plan, applyOptions) => {
        applied = applyOptions?.recordedPlan ?? _plan;
      },
    });

    await Effect.runPromise(selected.operation);
    const webId = selected.runtimes.get("web")?.containerId;
    const dbId = selected.runtimes.get("db")?.containerId;
    expect(webId).toBe("cid-web");
    expect(selected.applyCalls[0]?.options.complete).toBeUndefined();

    const rest = await Effect.runPromise(
      startApp({}, targetOf(plannedApp)).pipe(
        Effect.provideService(RouterService, TestRouterService),
        Effect.provide(selected.harness.layer),
      ),
    );

    expect(selected.applyCalls).toHaveLength(2);
    expect(selected.applyCalls[1]?.options.complete).toBe(true);
    expect(Object.keys(selected.applyCalls[1]?.plan.services ?? {}).sort()).toEqual(["db", "redis", "web"]);
    expect(selected.stopCalls).toEqual([]);
    expect(selected.removed).toEqual([]);
    expect(selected.runtimes.get("web")?.containerId).toBe(webId);
    expect(selected.runtimes.get("db")?.containerId).toBe(dbId);
    expect(rest.servicesStayedDown).toBeUndefined();
    expect(rest.servicesRemoved).toEqual([]);
  });

  test("prepares new accelerated mounts for the selection and its prerequisites", async () => {
    const withDb = withAcceleratedBind(threeServicePlan(), db.name, {
      type: "bind",
      source: AbsolutePath.make(`${plan.root}/data`),
      target: PortablePath.make("/data"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "data",
      excludes: [],
    });
    const plannedApp = withAcceleratedBind(withDb, web.name, {
      type: "bind",
      source: plan.root,
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "app-mount",
      excludes: [],
    });
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(undefined),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
      },
    });

    await Effect.runPromise(selected.operation);

    expect(selected.prepared).toHaveLength(1);
    expect(Object.keys(selected.prepared[0]?.services ?? {}).sort()).toEqual(["db", "web"]);
    expect(selected.prepared[0]?.fileSync.map((entry) => String(entry.session.service)).sort()).toEqual([
      "db",
      "web",
    ]);
    expect(selected.applyCalls[0]?.options.complete).toBeUndefined();
  });

  test("unknown and empty service names fail with ServiceNotFoundError before mutation", async () => {
    const plannedApp = threeServicePlan();
    for (const services of [[ServiceName.make("missing")], [ServiceName.make("")]] as const) {
      const selected = runStart(plannedApp, {
        services,
        resolveAppliedPlan: () => Effect.succeed(undefined),
      });
      const error = await Effect.runPromise(Effect.flip(selected.operation));
      expect(error).toBeInstanceOf(ServiceNotFoundError);
      expect(error).toMatchObject({ _tag: "ServiceNotFoundError" });
      expect(selected.applyCalls).toEqual([]);
      expect(selected.stopCalls).toEqual([]);
      expect(selected.removed).toEqual([]);
    }
  });

  test("first selected start with an unselected accelerated sibling keeps coverage, stop, and later bare start", async () => {
    const plannedApp = acceleratedSiblingPlan();
    let applied: AppPlan | undefined;
    const stateRetirements: Array<boolean | undefined> = [];
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      afterApply: (_plan, applyOptions) => {
        applied = applyOptions?.recordedPlan ?? _plan;
      },
      fileSync: durableMutagenEngine(),
      onDestroy: (_target, options) => {
        stateRetirements.push(options?.removeState);
      },
      providerOverrides: {
        inspectAppliedFileSync: () =>
          Effect.sync(() => {
            if (applied === undefined) return { status: "missing" as const };
            if (hasStructuralFileSyncCoverage(applied, { pathEquals: sameRealpath })) {
              const engineId = applied.fileSync[0]?.engineId;
              if (engineId === undefined) return { status: "unknown" as const };
              return {
                status: "accelerated" as const,
                engineId,
                sessions: applied.fileSync.map(({ session }) => session),
              };
            }
            if (
              applied.fileSync.length > 0 ||
              Object.values(applied.services).some((service) =>
                service.mounts.some((mount) => mount.type === "bind" && mount.realization === "accelerated"),
              )
            )
              return { status: "unknown" as const };
            return { status: "ordinary" as const };
          }),
      },
    });

    const first = await Effect.runPromise(selected.operation);
    if (applied === undefined) throw new Error("expected a recorded plan after the selected start");

    expect(hasStructuralFileSyncCoverage(applied, { pathEquals: sameRealpath })).toBe(true);
    expect(applied.services[redis.name]).toBeUndefined();
    expect(first.servicesStayedDown).toEqual(["redis"]);
    expect(selected.runtimes.has("redis")).toBe(false);

    const stopped = await Effect.runPromise(
      stopApp({}, targetOf(plannedApp)).pipe(Effect.provide(selected.harness.layer)),
    );
    expect(stopped.servicesStopped.toSorted()).toEqual(["db", "web"]);

    const webId = selected.runtimes.get("web")?.containerId;
    const rest = await Effect.runPromise(
      startApp({}, targetOf(plannedApp)).pipe(
        Effect.provideService(RouterService, TestRouterService),
        Effect.provide(selected.harness.layer),
      ),
    );

    expect(stateRetirements.includes(true)).toBe(false);
    expect(Object.keys(selected.applyCalls[1]?.plan.services ?? {}).sort()).toEqual(["db", "redis", "web"]);
    expect(
      selected.prepared.map((syncPlan) =>
        syncPlan.fileSync.map((entry) => String(entry.session.service)).sort(),
      ),
    ).toEqual([["web"], ["redis", "web"]]);
    expect(selected.runtimes.get("web")?.containerId).toBe(webId);
    expect(selected.runtimes.has("redis")).toBe(true);
    expect(rest.servicesStayedDown).toBeUndefined();
    expect(selected.removed).toEqual([]);
  });

  test.each([{ services: undefined }, { services: [redis.name] }, { services: [web.name] }])(
    "resumes the recorded selection before start scope $services",
    async ({ services }) => {
      const plannedApp = acceleratedSiblingPlan();
      const selectedPlan: AppPlan = {
        ...plannedApp,
        services: Object.fromEntries(
          [db.name, web.name].flatMap((name) => {
            const service = plannedApp.services[name];
            return service === undefined ? [] : [[name, service]];
          }),
        ),
        fileSync: plannedApp.fileSync.filter((entry) => String(entry.session.service) === String(web.name)),
      };
      const stateRetirements: Array<boolean | undefined> = [];
      const rest = runStart(plannedApp, {
        ...(services === undefined ? {} : { services }),
        fileSync: durableMutagenEngine(),
        onDestroy: (_target, options) => {
          stateRetirements.push(options?.removeState);
        },
      });
      const planted = await Effect.runPromise(
        beginOrResumeAcceleratedStart(selectedPlan, targetOf(plannedApp).app, [db.name, web.name]).pipe(
          Effect.provide(rest.harness.layer),
        ),
      );
      expect(planted.record.sessions.map((session) => session.name)).toEqual([`${web.name}/app-mount`]);
      expect(
        await Effect.runPromise(
          readPendingAcceleratedStart(targetOf(plannedApp).app).pipe(Effect.provide(rest.harness.layer)),
        ),
      ).toMatchObject({ attemptId: planted.attemptId, services: [db.name, web.name] });

      await Effect.runPromise(rest.operation);

      expect(stateRetirements.includes(true)).toBe(false);
      expect(rest.harness.events.filter(({ _tag }) => _tag === "pre-init")).toHaveLength(1);
      expect(
        rest.prepared.map((syncPlan) =>
          syncPlan.fileSync.map((entry) => String(entry.session.service)).sort(),
        ),
      ).toEqual(
        services === undefined
          ? [["web"], ["redis", "web"]]
          : services.includes(redis.name)
            ? [["web"], ["redis"]]
            : [["web"]],
      );
      expect(
        await Effect.runPromise(
          readPendingAcceleratedStart(targetOf(plannedApp).app, plannedApp).pipe(
            Effect.provide(rest.harness.layer),
          ),
        ),
      ).toBeNull();
    },
  );

  test("resumes a whole-app attempt before applying the selected request", async () => {
    const plannedApp = acceleratedSiblingPlan();
    const rest = runStart(plannedApp, { services: [web.name], fileSync: durableMutagenEngine() });
    await Effect.runPromise(
      beginOrResumeAcceleratedStart(plannedApp, targetOf(plannedApp).app).pipe(
        Effect.provide(rest.harness.layer),
      ),
    );
    const result = await Effect.runPromise(rest.operation);
    expect(rest.applyCalls.map(({ options }) => options.complete)).toEqual([true, undefined]);
    expect(rest.stopCalls).toEqual([]);
    expect(result.servicesStayedDown).toBeUndefined();
    expect(rest.harness.events.filter(({ _tag }) => _tag === "pre-init")).toHaveLength(1);
  });

  test("a wider start refuses to reseed a pending durable session missing after apply intent", async () => {
    const plannedApp = acceleratedSiblingPlan();
    const rest = runStart(plannedApp, { fileSync: durableMutagenEngine() });
    const target = targetOf(plannedApp);
    const pending = await Effect.runPromise(
      Effect.gen(function* () {
        const selected = yield* selectRebuildPlan(plannedApp, [web.name]);
        const attempt = yield* beginOrResumeAcceleratedStart(selected, target.app, [db.name, web.name]);
        yield* attempt.advance("record-sessions");
        yield* attempt.advance("record-apply-intent");
        return attempt;
      }).pipe(Effect.provide(rest.harness.layer)),
    );

    const failure = await Effect.runPromise(Effect.flip(rest.operation));
    expect(failure).toMatchObject({
      _tag: "FileSyncStartError",
      message: expect.stringContaining("history cannot be recovered"),
    });
    expect(rest.applyCalls).toEqual([]);
    const record = await Effect.runPromise(
      readPendingAcceleratedStart(target.app).pipe(Effect.provide(rest.harness.layer)),
    );
    expect(record).toMatchObject({ attemptId: pending.attemptId, phase: "apply-intent" });
  });

  test.each(["changed", "removed", "ordinary-sibling"] as const)(
    "checks selected file-sync transitions before hooks: %s",
    async (transition) => {
      const applied = await Effect.runPromise(selectRebuildPlan(acceleratedSiblingPlan(), [web.name]));
      const desired =
        transition === "changed"
          ? withAcceleratedBind(threeServicePlan(), web.name, {
              type: "bind",
              source: plan.root,
              target: PortablePath.make("/app"),
              readOnly: false,
              realization: "accelerated",
              mountKey: "app-mount",
              excludes: ["changed"],
            })
          : threeServicePlan();
      const selected = runStart(desired, {
        services: [transition === "ordinary-sibling" ? redis.name : web.name],
        resolveAppliedPlan: () => Effect.succeed(applied),
        appliedFileSyncState: "accelerated",
        appliedFileSyncSessions: applied.fileSync.map(({ session }) => session),
      });

      if (transition === "ordinary-sibling") {
        const result = await Effect.runPromise(selected.operation);
        expect(result.servicesStarted.map(({ name }) => name)).toEqual([redis.name]);
        expect(selected.prepared).toEqual([]);
      } else {
        const failure = await Effect.runPromise(Effect.flip(selected.operation));
        expect(failure).toBeInstanceOf(FileSyncStartError);
        expect(failure.remediation).toContain("`lando start`");
        expect(selected.harness.events.some(({ _tag }) => _tag === "pre-init" || _tag === "pre-start")).toBe(
          false,
        );
        expect(selected.applyCalls).toEqual([]);
      }
    },
  );

  test.each([false, true])(
    "whole start adds a new accelerated service without rotating, interrupted=%s",
    async (interrupt) => {
      const desired = acceleratedSiblingPlan();
      const firstPlan = await Effect.runPromise(selectRebuildPlan(desired, [web.name]));
      const engine = durableMutagenEngine();
      const created: string[] = [];
      let applied: AppPlan | undefined;
      let interruptFlush = false;
      const selected = runStart(desired, {
        resolveAppliedPlan: () => Effect.succeed(applied),
        afterApply: (plan, options) => {
          applied = options?.recordedPlan ?? plan;
        },
        fileSync: {
          ...engine,
          createSession: (spec) =>
            engine.createSession(spec).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  created.push(spec.service);
                }),
              ),
            ),
          listSessions: (filter) => engine.listSessions(filter),
          flushSession: (ref) =>
            Effect.suspend(() => {
              if (!interruptFlush || !String(ref).includes("redis")) return engine.flushSession(ref);
              interruptFlush = false;
              return Effect.interrupt;
            }),
        },
        providerOverrides: {
          inspectAppliedFileSync: () =>
            Effect.sync(() =>
              applied === undefined
                ? { status: "missing" as const }
                : {
                    status: "accelerated" as const,
                    engineId: "mutagen",
                    sessions: applied.fileSync.map(({ session }) => session),
                  },
            ),
        },
      });
      await Effect.runPromise(startApp({}, targetOf(firstPlan)).pipe(Effect.provide(selected.harness.layer)));
      const webId = selected.runtimes.get(web.name)?.containerId;
      const before = await Effect.runPromise(engine.listSessions({ app: targetOf(firstPlan).app }));
      if (interrupt) {
        interruptFlush = true;
        const exit = await Effect.runPromiseExit(selected.operation);
        expect(exit._tag).toBe("Failure");
        expect(selected.applyCalls).toHaveLength(1);
      }
      await Effect.runPromise(selected.operation);
      const after = await Effect.runPromise(engine.listSessions({ app: targetOf(desired).app }));
      expect(created).toEqual([web.name, redis.name]);
      expect(after.find(({ service }) => service === web.name)?.ref).toBe(before[0]?.ref);
      expect(selected.runtimes.get(web.name)?.containerId).toBe(webId);
      expect(selected.stopCalls).toEqual([]);
    },
  );

  test.each(["restart", "stop", "destroy"] as const)(
    "%s handles an open selected journal beside an applied sibling",
    async (verb) => {
      const desired = acceleratedSiblingPlan();
      const target = targetOf(desired);
      const appliedSibling = await Effect.runPromise(selectRebuildPlan(desired, [redis.name]));
      const engine = durableMutagenEngine();
      const quiesced: string[][] = [];
      const disposed: string[][] = [];
      let applied = appliedSibling;
      const harness = runStart(desired, {
        resolveAppliedPlan: () => Effect.succeed(applied),
        afterApply: (plan, options) => {
          applied = mergeAppliedPlan(applied, options?.recordedPlan ?? plan);
        },
        fileSync: engine,
        quiesceRetainedFileSync: (plan) =>
          Effect.sync(() => {
            quiesced.push(plan.fileSync.map(({ session }) => String(session.service)).toSorted());
            return {
              preparedVolumeNames: plan.fileSync.flatMap(({ session }) =>
                session.target._tag === "volume" ? [session.target.name] : [],
              ),
            };
          }),
        disposeFileSyncTargets: (plan) =>
          Effect.sync(() => {
            disposed.push(plan.fileSync.map(({ session }) => String(session.service)).toSorted());
          }),
        providerOverrides: {
          inspectAppliedFileSync: () =>
            Effect.sync(() => ({
              status: "accelerated" as const,
              engineId: "mutagen",
              sessions: applied.fileSync.map(({ session }) => session),
            })),
        },
      });
      const attempt = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const selected = yield* selectRebuildPlan(desired, [web.name]);
            const attempt = yield* beginOrResumeAcceleratedStart(selected, target.app, [db.name, web.name]);
            for (const { session } of [...appliedSibling.fileSync, ...selected.fileSync])
              yield* engine.createSession(session);
            yield* attempt.advance("record-sessions");
            yield* attempt.advance("record-apply-intent");
            return attempt;
          }),
        ).pipe(Effect.provide(harness.harness.layer)),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          switch (verb) {
            case "restart":
              yield* restartApp({ services: [web.name] }, target);
              break;
            case "stop":
              yield* stopApp({}, target);
              break;
            case "destroy":
              yield* destroyApp({ yes: true }, target);
              break;
          }
        }).pipe(Effect.provide(harness.harness.layer)),
      );
      const record = await Effect.runPromise(
        readPendingAcceleratedStart(target.app).pipe(Effect.provide(harness.harness.layer)),
      );
      if (verb === "stop") {
        expect(record).toMatchObject({ attemptId: attempt.attemptId, phase: "apply-intent" });
        expect(quiesced).toEqual([["redis", "web"]]);
        expect(disposed).toEqual([]);
      } else expect(record).toBeNull();
      if (verb === "destroy") {
        expect(quiesced).toEqual([["redis", "web"]]);
        expect(disposed).toEqual([["redis", "web"]]);
      }
      if (verb === "restart") expect(harness.stopCalls).toEqual([web.name]);
    },
  );

  test("restart can create a desired-only sibling after a partial first start", async () => {
    const plannedApp = threeServicePlan();
    let applied: AppPlan | undefined;
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      afterApply: (incoming, options) => {
        applied = mergeAppliedPlan(applied, options?.recordedPlan ?? incoming);
      },
    });
    await Effect.runPromise(selected.operation);
    expect(applied?.services[redis.name]).toBeUndefined();
    await Effect.runPromise(
      restartApp({ services: [redis.name] }, targetOf(plannedApp)).pipe(
        Effect.provide(selected.harness.layer),
      ),
    );
    expect(selected.runtimes.get("redis")?.status).toBe("running");
  });

  test("unverified and restarting siblings are not reported as down", async () => {
    const plannedApp = threeServicePlan();
    const failingService = ServiceName.make("unverified");
    const desired = {
      ...plannedApp,
      services: { ...plannedApp.services, [failingService]: { ...redis, name: failingService } },
    };
    const selected = runStart(desired, {
      services: [web.name],
      inspect: ({ service }) =>
        service === failingService
          ? Effect.fail(
              new ProviderUnavailableError({
                providerId: "lando",
                operation: "inspect",
                message: "Unavailable",
                remediation: "Retry inspection.",
              }),
            )
          : Effect.succeed<ServiceRuntimeInfo>(
              service === redis.name
                ? {
                    app: desired.id,
                    service,
                    providerId: desired.provider,
                    status: "restarting",
                    publications: { status: "unknown" },
                  }
                : runtimeFor(desired, service),
            ),
    });
    expect((await Effect.runPromise(selected.operation)).servicesStayedDown).toBeUndefined();
  });

  test("info after a partial first start includes desired-only services", async () => {
    const plannedApp = threeServicePlan();
    let applied: AppPlan | undefined;
    const selected = runStart(plannedApp, {
      services: [web.name],
      resolveAppliedPlan: () => Effect.succeed(applied),
      afterApply: (_plan, applyOptions) => {
        applied = applyOptions?.recordedPlan ?? _plan;
      },
    });

    await Effect.runPromise(selected.operation);
    const info = await Effect.runPromise(
      infoApp({}, targetOf(plannedApp)).pipe(Effect.provide(selected.harness.layer)),
    );

    const status = Object.fromEntries(info.services.map((service) => [service.service, service.status]));
    expect(status.web).toBe("running");
    expect(status.db).toBe("running");
    expect(status.redis).toBe("stopped");
    const filtered = await Effect.runPromise(
      infoApp({ services: [redis.name] }, targetOf(plannedApp)).pipe(Effect.provide(selected.harness.layer)),
    );
    expect(filtered.services).toEqual([
      expect.objectContaining({ service: "redis", status: "stopped", connections: [] }),
    ]);
    expect(filtered.services[0]?.mounts).toBeUndefined();
  });
});
