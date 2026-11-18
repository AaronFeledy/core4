import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import { makeLandoPaths } from "@lando/paths";
import { LandofileValidationError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ProviderRuntimeSnapshot, ServiceRuntimeInfo } from "@lando/sdk/services";
import {
  AppPlanner,
  ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  ScratchAppService,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { pendingStartBucketSpec } from "../../src/operations/accelerated-start-record.ts";
import { poweroff } from "../../src/operations/poweroff.ts";
import { HostMaintenanceRegistry } from "../../src/runtime/host-maintenance.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { layerTransactionGuard } from "../services/landofile-layer.ts";
import { emptySnapshotsLayer } from "./data-mover-support.ts";

const providerId = ProviderId.make("lando");
const dataRoot = await mkdtemp(join(tmpdir(), "lando-poweroff-data-"));
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

const ownerKey = (root: string): string => appIdentityKey("owner", root);

const planAt = (root: string, id = "twin", provider = providerId): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
  provider,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const serviceAt = (root: string, app: string, status: ServiceRuntimeInfo["status"]): ServiceRuntimeInfo => ({
  app: AppId.make(app),
  appRoot: AbsolutePath.make(root),
  service: ServiceName.make("web"),
  providerId,
  status,
  containerId: `${app}-web`,
  publications: { status: "unknown" as const },
});

const fakeConfigService = Layer.succeed(
  ConfigService,
  ConfigService.of({
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never),
);

const makeHarness = async (input: {
  readonly roots: ReadonlyArray<{
    readonly root: string;
    readonly plan: AppPlan;
    readonly status: ServiceRuntimeInfo["status"];
  }>;
  readonly quiescent?: { readonly root: string; readonly plan: AppPlan };
  readonly failRoot?: string;
  readonly runtimeObserved?: boolean;
  readonly observationFailure?: ProviderUnavailableError;
  readonly statusFailure?: boolean;
  readonly idle?: boolean;
  readonly holdingPlans?: ReadonlyArray<AppPlan>;
  readonly globalPlans?: ReadonlyArray<AppPlan>;
  readonly observedGlobalRoots?: readonly string[];
}) => {
  const teardown = await globalTeardownHarness(dataRoot);
  const calls: string[] = [];
  const failures = new Map<string, ProviderUnavailableError>();
  if (input.failRoot !== undefined)
    failures.set(
      input.failRoot,
      new ProviderUnavailableError({
        providerId,
        operation: "destroy",
        message: `Cannot stop the app at ${input.failRoot}.`,
        remediation: "Restore provider access and retry `lando poweroff`.",
      }),
    );
  const plans = new Map(input.roots.map((entry) => [entry.root, entry.plan]));
  const services: ServiceRuntimeInfo[] = input.roots.map((entry) =>
    serviceAt(entry.root, String(entry.plan.id), entry.status),
  );
  if (input.quiescent !== undefined)
    services.push(serviceAt(input.quiescent.root, String(input.quiescent.plan.id), "exited"));
  const globalServices = (input.observedGlobalRoots ?? []).map((root, index) => {
    const service = `global-${index}`;
    return {
      ...serviceAt(root, "global", "running"),
      service: ServiceName.make(service),
      containerId: service,
      labels: { [APP_LABEL]: "global", [APP_ROOT_LABEL]: root, [SERVICE_LABEL]: service },
    };
  });
  services.push(...globalServices);
  const snapshot: ProviderRuntimeSnapshot = {
    providerId,
    runtimeObserved: input.runtimeObserved ?? true,
    appliedPlans: [...(input.holdingPlans ?? []), ...(input.globalPlans ?? [])],
    services,
    volumes: [],
  };
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    appliedPlans: Effect.succeed(snapshot.appliedPlans),
    getStatus: input.statusFailure
      ? Effect.fail(
          new ProviderUnavailableError({
            providerId,
            operation: "getStatus",
            message: "Cannot observe the runtime.",
            remediation: "Restore provider access and retry.",
          }),
        )
      : Effect.succeed({ state: input.idle === true ? ("idle" as const) : ("running" as const) }),
    list: () => Effect.succeed(globalServices),
    listVolumes: () => Effect.succeed([]),
    removeObservedService: (service: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        calls.push(`remove:${service.appRoot}`);
        return { kind: "removed" as const };
      }),
    destroy: (target: { readonly app: string; readonly plan?: AppPlan }) =>
      Effect.gen(function* () {
        calls.push(`destroy:${target.plan?.root ?? "global"}`);
        const failure = target.plan === undefined ? undefined : failures.get(String(target.plan.root));
        if (failure !== undefined) return yield* Effect.fail(failure);
        return { kind: "destroyed" as const, volumesRemoved: { data: 0, cache: 0 } };
      }),
  };
  const registry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedStateInventory: () => Effect.succeed({ plans: input.holdingPlans ?? [], unreadable: [] }),
    observeRuntime:
      input.observationFailure === undefined
        ? Effect.succeed([snapshot])
        : Effect.fail(input.observationFailure),
    appliedPlansFor: (root: AbsolutePath, scope?: ProviderId) => {
      const user =
        (scope === undefined || scope === providerId) && plans.has(root) ? [plans.get(root) as AppPlan] : [];
      const global = (input.globalPlans ?? []).filter(
        (plan) =>
          (scope === undefined || plan.provider === scope) &&
          (plan.identity?.appRoot === root || plan.root === root),
      );
      return Effect.succeed([...user, ...global]);
    },
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: (root: AbsolutePath) =>
      Effect.succeed(
        plans.has(root)
          ? { kind: "applied" as const, plan: plans.get(root) as AppPlan }
          : { kind: "absent" as const },
      ),
    resourceOwnership: () => Effect.succeed(undefined),
    select: () => Effect.succeed(provider),
  };
  const scratch = Layer.succeed(
    ScratchAppService,
    ScratchAppService.of({
      kind: "scratch",
      root: Effect.succeed(AbsolutePath.make(dataRoot)),
      ensureRoot: Effect.die("unexpected ensureRoot"),
      synthesizeId: () => Effect.die("unexpected synthesizeId"),
      paths: () => Effect.die("unexpected paths"),
      acquire: () => Effect.die("unexpected acquire"),
      resolveById: () => Effect.die("unexpected resolve"),
      list: () => Effect.succeed([]),
      info: () => Effect.die("unexpected info"),
      start: () => Effect.die("unexpected start"),
      stop: () => Effect.die("unexpected stop"),
      destroy: () => Effect.die("unexpected destroy"),
      gc: () => Effect.die("unexpected gc"),
    }),
  );
  const runtime = Layer.succeed(
    HostMaintenanceRegistry,
    HostMaintenanceRegistry.of({
      maintainers: [
        {
          pluginId: "@lando/test",
          id: "runtime",
          teardown: () => {
            calls.push("runtime");
            return Effect.succeed({ terminated: true, pid: 4242 });
          },
        },
      ],
    }),
  );
  const invalidLandofile = new LandofileValidationError({
    message: "The current Landofile is invalid.",
    remediation: "Fix the current Landofile before applying it.",
    file: ".lando.yml",
    issues: [{ path: [], message: "invalid test fixture" }],
  });
  const fakeLandofile = Layer.succeed(
    LandofileService,
    LandofileService.of({ discover: Effect.fail(invalidLandofile) }),
  );
  const planner = Layer.succeed(
    AppPlanner,
    AppPlanner.of({ plan: () => Effect.die("no desired plan may be built during poweroff inventory") }),
  );
  const layer = Layer.mergeAll(
    teardown.layer,
    layerTransactionGuard,
    emptySnapshotsLayer,
    fakeConfigService,
    scratch,
    runtime,
    fakeLandofile,
    planner,
    Layer.succeed(RuntimeProviderRegistry, registry as never),
  );
  return { layer, calls, events: teardown.events, routeRoots: teardown.routeRoots };
};

const withRoots = async <A>(
  use: (roots: { readonly a: string; readonly b: string; readonly quiet: string }) => Promise<A>,
): Promise<A> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "lando-poweroff-")));
  const a = join(parent, "a");
  const b = join(parent, "b");
  const quiet = join(parent, "quiet");
  await Promise.all(
    [a, b, quiet].map((root) =>
      Bun.write(join(root, ".lando.yml"), `name: ${root === quiet ? "quiet" : "twin"}\n`),
    ),
  );
  try {
    return await use({ a, b, quiet });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
};

describe("poweroff operation", () => {
  test("stops two apps with the same id at different roots", async () => {
    await withRoots(async ({ a, b, quiet }) => {
      const harness = await makeHarness({
        roots: [
          { root: a, plan: planAt(a), status: "running" },
          { root: b, plan: planAt(b), status: "running" },
        ],
        quiescent: { root: quiet, plan: planAt(quiet, "quiet") },
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      const users = result.apps.filter((app) => app.kind === "user");
      expect(users.map((app) => app.appRoot).sort()).toEqual([a, b].sort());
      expect(users.every((app) => app.outcome === "stopped")).toBe(true);
      expect(harness.calls.filter((call) => call.startsWith("destroy:"))).toHaveLength(2);
      expect(harness.calls).not.toContain(`destroy:${quiet}`);
    });
  });

  test("stops an unknown container while skipping a confirmed quiescent app", async () => {
    await withRoots(async ({ a, quiet }) => {
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "unknown" }],
        quiescent: { root: quiet, plan: planAt(quiet, "quiet") },
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      expect(result.apps.filter((app) => app.kind === "user").map((app) => app.appId)).toEqual(["twin"]);
      expect(harness.calls).not.toContain(`destroy:${quiet}`);
      expect(harness.calls.filter((call) => call.startsWith("destroy:"))).toEqual([`destroy:${a}`]);
    });
  });

  test("continues past one user failure and skips global and runtime teardown", async () => {
    await withRoots(async ({ a, b }) => {
      const harness = await makeHarness({
        roots: [
          { root: a, plan: planAt(a), status: "running" },
          { root: b, plan: planAt(b), status: "running" },
        ],
        failRoot: a,
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
      if (result.failure._tag !== "PoweroffStopError")
        throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
      expect(result.failure).toMatchObject({
        _tag: "PoweroffStopError",
        failures: [
          {
            kind: "user",
            appRoot: a,
            _tag: "ProviderUnavailableError",
            providerId: "lando",
          },
        ],
      });
      expect(result.failure.apps.some((app) => app.kind === "user" && app.appRoot === b)).toBe(true);
      expect(result.failure.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
      expect(harness.calls).not.toContain("runtime");
    });
  });

  test("keeps the global app and runtime service even when its placement conflicts", async () => {
    await withRoots(async ({ a }) => {
      const globalRoot = makeLandoPaths({ userDataRoot: dataRoot }).globalAppRoot;
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "running" }],
        globalPlans: [planAt(globalRoot, "global"), planAt(globalRoot, "global", ProviderId.make("docker"))],
      });
      const result = await Effect.runPromise(
        poweroff({ keepGlobal: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.keptGlobalApp).toBe(true);
      expect(harness.calls).not.toContain("runtime");
      expect(result.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
    });
  });

  test("aggregates conflicting global placement before any global mutation", async () => {
    const globalRoot = makeLandoPaths({ userDataRoot: dataRoot }).globalAppRoot;
    const harness = await makeHarness({
      roots: [],
      globalPlans: [
        planAt(globalRoot, "global", providerId),
        planAt(globalRoot, "global", ProviderId.make("docker")),
      ],
    });
    const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
    if (result.failure._tag !== "PoweroffStopError")
      throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
    expect(result.failure.failures).toMatchObject([
      { kind: "global", appId: "global", _tag: "AppResolveError" },
    ]);
    expect(harness.calls).not.toContain("runtime");
  });

  test.each(["container", "applied plan"] as const)(
    "stops the global root discovered from the %s",
    async (source) => {
      await withRoots(async ({ a, b }) => {
        const harness = await makeHarness({
          roots: [],
          globalPlans: [globalPlanAt(AbsolutePath.make(source === "container" ? b : a))],
          ...(source === "container" ? { observedGlobalRoots: [a, a] } : {}),
        });

        const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));

        expect(result).toMatchObject({
          _tag: "Success",
          success: { apps: [{ kind: "global", appRoot: a, providerId, outcome: "stopped" }] },
        });
        expect(harness.events.filter((event) => event._tag === "pre-global-stop")).toMatchObject([
          { app: { root: a }, triggeredBy: "apps:poweroff" },
        ]);
        expect(harness.routeRoots).toEqual([a]);
      });
    },
  );

  test("refuses multiple discovered global roots before stopping containers or withdrawing routes", async () => {
    await withRoots(async ({ a, b }) => {
      const harness = await makeHarness({ roots: [], observedGlobalRoots: [b, a] });

      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PoweroffStopError",
          failures: [
            { kind: "global", _tag: "AppResolveError", message: expect.stringContaining(`${a}, ${b}`) },
          ],
        },
      });
      expect(harness.calls).toEqual([]);
      expect(harness.routeRoots).toEqual([]);
    });
  });

  test("fails a provider with recorded holdings when its runtime status check fails", async () => {
    await withRoots(async ({ a }) => {
      const harness = await makeHarness({
        roots: [],
        runtimeObserved: false,
        statusFailure: true,
        holdingPlans: [planAt(a)],
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
      if (result.failure._tag !== "PoweroffStopError")
        throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
      expect(result.failure.failures).toMatchObject([
        {
          providerId: "lando",
          _tag: "ProviderUnavailableError",
          kind: "user",
          appId: "lando",
        },
      ]);
      expect(result.failure.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
      expect(harness.calls).not.toContain("runtime");
    });
  });

  test("does not fail an unobserved provider that holds nothing", async () => {
    await withRoots(async () => {
      const harness = await makeHarness({
        roots: [],
        runtimeObserved: false,
        idle: true,
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      expect(result.runtimeServiceStopped).toBe(true);
      expect(harness.calls).toEqual(["runtime"]);
    });
  });

  test.each(["running", "idle", "unavailable"] as const)(
    "classifies failed inventory without holdings when provider status is %s",
    async (status) => {
      const harness = await makeHarness({
        roots: [],
        idle: status === "idle",
        statusFailure: status === "unavailable",
        observationFailure: new ProviderUnavailableError({
          providerId,
          operation: "observeRuntime",
          message: "The container inventory could not be read.",
          remediation: "Restore provider access and retry.",
        }),
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));
      if (status === "running") {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PoweroffStopError",
            failures: [{ providerId, _tag: "ProviderUnavailableError" }],
          },
        });
        expect(harness.calls).not.toContain("runtime");
      } else {
        expect(result).toMatchObject({ _tag: "Success" });
      }
    },
  );

  test("reports every unreadable accelerated-start journal and keeps the runtime running", async () => {
    await withRoots(async () => {
      const harness = await makeHarness({ roots: [] });
      const probe = await Effect.runPromise(
        StateStore.pipe(
          Effect.flatMap((store) => store.open(pendingStartBucketSpec("inventory.json"))),
          Effect.provide(harness.layer),
        ),
      );
      const journalPath = join(dirname(probe.path), `${"a".repeat(64)}.json`);
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, "{ not a journal");
      try {
        const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));

        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
        if (result.failure._tag !== "PoweroffStopError")
          throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
        expect(result.failure.failures).toMatchObject([
          {
            appId: journalPath,
            providerId: "journals",
            _tag: "ProviderUnavailableError",
          },
        ]);
        expect(harness.calls).not.toContain("runtime");
      } finally {
        await rm(journalPath, { force: true });
      }
    });
  });

  test("stops the runtime service once, after every app and the global stop", async () => {
    await withRoots(async ({ a }) => {
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "running" }],
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      expect(harness.routeRoots).toContain(makeLandoPaths({ userDataRoot: dataRoot }).globalAppRoot);
      expect(result.runtimeServiceStopped).toBe(true);
      expect(result.runtimeServicePid).toBe(4242);
      expect(harness.calls.filter((call) => call === "runtime")).toHaveLength(1);
      expect(harness.calls.at(-1)).toBe("runtime");
    });
  });
});
