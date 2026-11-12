import { expect, test } from "bun:test";
import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import { APP_LABEL, APP_ROOT_LABEL, PROVIDER_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import { rememberAppliedPlan } from "@lando/container-runtime/provider-assembly";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  PortablePath,
  ServiceName,
  type ServicePlan,
  fileSyncVolumeName,
  planAppIdentity,
} from "@lando/sdk/schema";
import type { ApplyOptions, ListFilter, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  app as acceleratedApp,
  acceleratedPlan,
  session as acceleratedSession,
  recoveryHarness,
} from "./accelerated-start-recovery-support.ts";
import { appliedPlanRecord, byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const adminer: ServicePlan = {
  ...web,
  name: ServiceName.make("adminer"),
  primary: false,
  endpoints: [],
  routes: [],
  mounts: [
    {
      type: "volume",
      store: "adminer-data",
      target: PortablePath.make("/var/lib/adminer"),
      readOnly: false,
    },
  ],
};

const desired: AppPlan = { ...plan };

const withAdminer: AppPlan = {
  ...plan,
  services: { [web.name]: web, [adminer.name]: adminer },
  stores: [{ name: "adminer-data", scope: "app", kind: "data" }],
};

const target = {
  plan: desired,
  root: desired.root,
  app: { kind: "user" as const, id: desired.id, root: desired.root },
};

const removalNotices = (harness: ReturnType<typeof makeHarness>) =>
  byTag(harness.events, "message.info").filter((notice) => notice.body.includes("no longer defined"));

const observedAdminer = (
  overrides: Partial<Pick<ServiceRuntimeInfo, "service" | "containerId" | "labels">> = {},
): ServiceRuntimeInfo => ({
  app: desired.id,
  appRoot: planAppIdentity(desired).appRoot,
  providerId: desired.provider,
  service: adminer.name,
  containerId: "adminer-container",
  status: "running",
  labels: {
    [APP_LABEL]: desired.id,
    [APP_ROOT_LABEL]: planAppIdentity(desired).appRoot,
    [SERVICE_LABEL]: String(adminer.name),
  },
  publications: { status: "unknown" },
  ...overrides,
});

/** The provider record as a fresh read sees it after every successful apply. */
const appliedRecord = (initial: AppPlan) => {
  let persisted: AppPlan | undefined = initial;
  const cache = makeAppliedPlanCache({
    providerId: plan.provider,
    providerName: "test",
    appliedPlanState: { open: () => Effect.die("unused"), withLock: (_key, body) => body },
    load: () => Effect.succeed(persisted),
    persist: (_state, value) =>
      Effect.sync(() => {
        persisted = value;
      }),
    remove: () => Effect.void,
  });
  return { cache, read: () => persisted };
};

const runningContainer = () => {
  const containers = [observedAdminer()];
  const removed: string[] = [];
  const providerOverrides = {
    list: (filter: ListFilter) =>
      Effect.succeed(containers.filter((entry) => filter.app === undefined || entry.app === filter.app)),
    removeObservedService: (observation: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        removed.push(String(observation.service));
        containers.splice(
          containers.findIndex((entry) => entry.containerId === observation.containerId),
          1,
        );
        return { kind: "removed" as const };
      }),
  };
  return { containers, removed, providerOverrides };
};

test("a whole-app start removes a removed service's owned container and drops it from the record", async () => {
  // Given an applied service that the Landofile no longer defines.
  const containers = runningContainer();
  const record = appliedRecord(withAdminer);
  const seen: Array<ApplyOptions | undefined> = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: containers.providerOverrides,
    onApply: (appliedPlan, options) => {
      seen.push(options);
      return options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options);
    },
  });

  // When the whole app starts.
  const result = await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));

  // Then exactly the removed service's container is removed through the observed identity.
  expect(result.servicesRemoved).toEqual([String(adminer.name)]);
  expect(containers.removed).toEqual([String(adminer.name)]);
  expect(containers.containers).toEqual([]);
  expect(byTag(harness.events, "pre-service-stop").map((event) => event.serviceName)).toEqual([adminer.name]);
  expect(byTag(harness.events, "post-service-stop").map((event) => event.serviceName)).toEqual([
    adminer.name,
  ]);
  // And one notice says the Landofile no longer defines it and its volumes stayed.
  const notices = byTag(harness.events, "message.info");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toContain(String(adminer.name));
  expect(notices[0]?.body).toContain("Named volumes were kept");
  expect(notices[0]?.body).not.toContain("lando destroy --volumes");
  // The full desired plan replaces the applied record instead of carrying the removed service.
  expect(seen[0]?.complete).toBe(true);
  expect(seen[0]?.recordedPlan).toBeUndefined();
  expect(Object.keys(record.read()?.services ?? {})).toEqual([String(web.name)]);
  expect(record.read()?.stores).toEqual([]);
});

test("a second start over the converged app removes nothing and stays quiet", async () => {
  // Given a start that already converged the app.
  const containers = runningContainer();
  const record = appliedRecord(withAdminer);
  const seen: Array<ApplyOptions | undefined> = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: containers.providerOverrides,
    onApply: (appliedPlan, options) => {
      seen.push(options);
      return options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options);
    },
  });
  await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
  const before = byTag(harness.events, "pre-service-stop").length;

  // When it starts again.
  const result = await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));

  // Then the removed container is rediscovered as absent and nothing is re-announced.
  expect(result.servicesRemoved).toEqual([]);
  expect(byTag(harness.events, "pre-service-stop")).toHaveLength(before);
  expect(byTag(harness.events, "message.info")).toHaveLength(1);
  expect(containers.removed).toEqual([String(adminer.name)]);
  expect(seen[1]?.complete).toBe(true);
});

test("a removed service still in the record without a container is dropped, not refused", async () => {
  // Given a stop or restart halt already removed the container, so the provider only reports the
  // removed service from its applied record, as an absent snapshot with no container id or labels.
  const absent: ServiceRuntimeInfo = {
    app: desired.id,
    appRoot: desired.root,
    providerId: desired.provider,
    service: adminer.name,
    status: "absent",
    publications: { status: "missing" },
  };
  const record = appliedRecord(withAdminer);
  const removed: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: {
      list: () => Effect.succeed([absent]),
      removeObservedService: (observation: ServiceRuntimeInfo) =>
        Effect.sync(() => {
          removed.push(String(observation.service));
          return { kind: "absent" as const };
        }),
    },
    onApply: (appliedPlan, options) =>
      options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options),
  });

  // When the whole app starts.
  const result = await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));

  // Then nothing is removed or announced, and the record no longer names the service.
  expect(result.servicesRemoved).toEqual([]);
  expect(removed).toEqual([]);
  expect(byTag(harness.events, "pre-service-stop")).toEqual([]);
  expect(byTag(harness.events, "message.info")).toEqual([]);
  expect(Object.keys(record.read()?.services ?? {})).toEqual([String(web.name)]);
});

test("a failed removal stops the sweep, keeps earlier removals, and still announces them", async () => {
  // Given three removed services, swept in name order, whose second removal fails.
  const removedService = (name: string) =>
    observedAdminer({
      service: ServiceName.make(name),
      containerId: `${name}-container`,
      labels: { ...observedAdminer().labels, [SERVICE_LABEL]: name },
    });
  const attempted: string[] = [];
  const removed: string[] = [];
  const applies: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: {
      list: () => Effect.succeed([removedService("worker"), removedService("cache"), observedAdminer()]),
      removeObservedService: (observation: ServiceRuntimeInfo) =>
        Effect.sync(() => attempted.push(String(observation.service))).pipe(
          Effect.andThen(
            String(observation.service) === "cache"
              ? Effect.fail(
                  new ProviderUnavailableError({
                    providerId: String(desired.provider),
                    operation: "removeObservedService",
                    message: "cache removal failed",
                    remediation: "retry",
                  }),
                )
              : Effect.sync(() => {
                  removed.push(String(observation.service));
                  return { kind: "removed" as const };
                }),
          ),
        ),
    },
    onApply: (appliedPlan) =>
      Effect.sync(() => {
        applies.push(appliedPlan);
      }),
  });

  // When the whole app starts.
  const error = await Effect.runPromise(
    startApp({}, target).pipe(Effect.provide(harness.layer), Effect.flip),
  );

  // Then the sweep stops at the failure, the earlier removal stays done and announced, the failure
  // propagates, and nothing is applied.
  expect(error).toMatchObject({ _tag: "ProviderUnavailableError", message: "cache removal failed" });
  expect(attempted).toEqual([String(adminer.name), "cache"]);
  expect(removed).toEqual([String(adminer.name)]);
  const notices = byTag(harness.events, "message.info");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toContain(String(adminer.name));
  expect(notices[0]?.body).not.toContain("cache");
  expect(applies).toEqual([]);
});

test("fails closed before removing anything when a candidate's labels contradict ownership", async () => {
  // Given a running container that claims this app and root but belongs to another provider.
  const foreign = observedAdminer({ labels: { ...observedAdminer().labels, [PROVIDER_LABEL]: "docker" } });
  const removals: string[] = [];
  const applies: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: {
      list: () => Effect.succeed([foreign]),
      removeObservedService: (observation) =>
        Effect.sync(() => {
          removals.push(String(observation.service));
          return { kind: "removed" as const };
        }),
    },
    onApply: (appliedPlan) =>
      Effect.sync(() => {
        applies.push(appliedPlan);
      }),
  });

  // When the whole app starts.
  const result = await Effect.runPromise(
    Effect.result(startApp({}, target).pipe(Effect.provide(harness.layer))),
  );

  // Then it refuses with the ownership error, naming the container, before any mutation.
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    const error: unknown = result.failure;
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    if (error instanceof ProviderUnavailableError) {
      expect(error.operation).toBe("start");
      expect(error.message).toContain(String(adminer.name));
      expect(error.message).toContain("adminer-container");
      expect(error.remediation).toContain("lando start");
    }
  }
  expect(removals).toEqual([]);
  expect(applies).toEqual([]);
  expect(byTag(harness.events, "pre-service-stop")).toEqual([]);
});

test("re-adding a removed service later keeps its named store in the plan", async () => {
  // Given a record and runtime that no longer hold the service.
  const record = appliedRecord({ ...plan, services: { [web.name]: web } });
  const harness = makeHarness({
    plannedApp: withAdminer,
    providerOverrides: { list: () => Effect.succeed([]) },
    onApply: (appliedPlan, options) =>
      options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options),
  });

  // When the service is declared again and the app starts.
  await Effect.runPromise(startApp({}, { ...target, plan: withAdminer }).pipe(Effect.provide(harness.layer)));

  // Then the new record keeps the service and the named store it mounts.
  expect(Object.keys(record.read()?.services ?? {}).sort()).toEqual(["adminer", "web"]);
  expect(record.read()?.stores).toEqual([{ name: "adminer-data", scope: "app", kind: "data" }]);
  expect(byTag(harness.events, "message.info")).toEqual([]);
});

test("whole-app rebuild replaces the record through the complete start apply", async () => {
  // Given an applied service the Landofile no longer defines and its running container.
  const containers = runningContainer();
  const record = appliedRecord(withAdminer);
  const seen: Array<ApplyOptions | undefined> = [];
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [withAdminer],
    resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(withAdminer)),
    providerOverrides: containers.providerOverrides,
    onDestroy: () => {
      containers.containers.splice(0);
    },
    onApply: (appliedPlan, options) => {
      seen.push(options);
      return options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options);
    },
  });

  // When the whole app rebuilds.
  const result = await Effect.runPromise(rebuildApp({}, target).pipe(Effect.provide(harness.layer)));

  // Then the halt removed the container, the rebuild announced it once, and the start apply
  // replaces the record with the whole desired plan.
  expect(containers.containers).toEqual([]);
  expect(result.servicesRemoved).toEqual([String(adminer.name)]);
  const notices = removalNotices(harness);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toContain(String(adminer.name));
  expect(notices[0]?.body).toContain("Named volumes were kept");
  expect(seen.at(-1)?.complete).toBe(true);
  expect(Object.keys(record.read()?.services ?? {})).toEqual([String(web.name)]);
});

test("a whole-app restart reports and announces the service its halt removed", async () => {
  // Given an applied service the Landofile no longer defines and its running container.
  const containers = runningContainer();
  const record = appliedRecord(withAdminer);
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [withAdminer],
    resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(withAdminer)),
    providerOverrides: containers.providerOverrides,
    onDestroy: () => {
      containers.containers.splice(0);
    },
    onApply: (appliedPlan, options) =>
      options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options),
  });

  // When the whole app restarts.
  const result = await Effect.runPromise(restartApp({}, target).pipe(Effect.provide(harness.layer)));

  // Then the halt removed the container, named the service once, and reported it.
  expect(containers.containers).toEqual([]);
  expect(result.servicesRemoved).toEqual([String(adminer.name)]);
  const notices = removalNotices(harness);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toContain(String(adminer.name));
  expect(notices[0]?.body).toContain("Named volumes were kept");
});

test("a selected restart omits servicesRemoved and publishes no removal notice", async () => {
  // Given an applied service the Landofile no longer defines and its running container.
  const containers = runningContainer();
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [withAdminer],
    resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(withAdminer)),
    providerOverrides: containers.providerOverrides,
    onDestroy: () => {
      containers.containers.splice(0);
    },
    onApply: () => Effect.void,
  });

  // When only the surviving service restarts.
  const result = await Effect.runPromise(
    restartApp({ services: [web.name] }, target).pipe(Effect.provide(harness.layer)),
  );

  // Then the removed service's container stays, nothing is announced, and the field is absent.
  expect(containers.removed).toEqual([]);
  expect(result.servicesRemoved).toBeUndefined();
  expect(removalNotices(harness)).toEqual([]);
});

test("selected rebuild keeps a removed but still-running service as cleanup evidence", async () => {
  // Given a running service the Landofile no longer defines and its applied record.
  const containers = runningContainer();
  const record = appliedRecord(withAdminer);
  const seen: Array<ApplyOptions | undefined> = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: containers.providerOverrides,
    onApply: (appliedPlan, options) => {
      seen.push(options);
      return options === undefined ? Effect.void : rememberAppliedPlan(record.cache, appliedPlan, options);
    },
  });

  // When only the surviving service is rebuilt.
  const result = await Effect.runPromise(
    rebuildApp({ services: [web.name] }, target).pipe(Effect.provide(harness.layer)),
  );

  // Then nothing is swept, nothing is announced, the field is absent, and the record still names
  // the removed service.
  expect(result.servicesRemoved).toBeUndefined();
  expect(removalNotices(harness)).toEqual([]);
  expect(containers.removed).toEqual([]);
  expect(seen[0]?.complete).not.toBe(true);
  expect(Object.keys(record.read()?.services ?? {}).sort()).toEqual(["adminer", "web"]);
  expect(record.read()?.stores).toEqual([{ name: "adminer-data", scope: "app", kind: "data" }]);
});

test("an unfinished accelerated journal refuses a changed mount plan before pruning", async () => {
  // Given an open accelerated attempt and a running container the Landofile no longer defines.
  let listed = 0;
  const removals: string[] = [];
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase: "sessions-ready",
      harnessOptions: {
        providerOverrides: {
          list: () => {
            listed += 1;
            return Effect.succeed([observedAdminer()]);
          },
          removeObservedService: (observation) =>
            Effect.sync(() => {
              removals.push(String(observation.service));
              return { kind: "removed" as const };
            }),
        },
      },
    }),
  );
  const acceleratedWeb = acceleratedPlan.services[web.name];
  if (acceleratedWeb === undefined) throw new TypeError("Missing accelerated web fixture");
  const changedPlan: AppPlan = {
    ...acceleratedPlan,
    services: {
      ...acceleratedPlan.services,
      [web.name]: {
        ...acceleratedWeb,
        mounts: [
          ...acceleratedWeb.mounts,
          {
            type: "bind",
            source: plan.root,
            target: PortablePath.make("/data"),
            readOnly: false,
            realization: "accelerated",
            excludes: [],
            includes: [],
            mountKey: "data-mount",
          },
        ],
      },
    },
    fileSync: [
      ...acceleratedPlan.fileSync,
      {
        engineId: "mutagen",
        session: {
          ...acceleratedSession,
          mountKey: "data-mount",
          target: {
            _tag: "volume",
            name: fileSyncVolumeName(plan.name, String(web.name), "data-mount"),
            path: PortablePath.make("/data"),
          },
        },
      },
    ],
  };

  // When start runs against a different mount plan.
  const result = await Effect.runPromise(
    Effect.result(
      startApp({}, { plan: changedPlan, root: plan.root, app: acceleratedApp }).pipe(
        Effect.provide(harness.layer),
      ),
    ),
  );

  // Then the journal identity check refuses before any observation or removal.
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    const error: unknown = result.failure;
    expect(error).toMatchObject({ _tag: "FileSyncStartError" });
    if (error instanceof Error) expect(error.message).toContain("mount plan");
  }
  expect(listed).toBe(0);
  expect(removals).toEqual([]);
});
