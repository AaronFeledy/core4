import { expect, spyOn, test } from "bun:test";
import { ProxyError } from "@lando/sdk/errors";
import { type AppPlan, GlobalConfig, LandofileShape, PluginManifest, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PluginRegistry, RouterService } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import * as AppPlanCache from "../../src/cache/app-plan.ts";
import * as Cache from "../../src/cache/service.ts";
import { routerBackingServices } from "../../src/global-app/router-admission.ts";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import * as ServiceCertificates from "../../src/lifecycle/service-certificates.ts";
import { withGlobalConsumerAdmission } from "../../src/operations/global-consumer-admission.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { plan as base, makeHarness, runStart } from "./start-progress-topology-support.ts";

const contributions = [
  { id: "custom", module: "./never-import.ts", requires: { globalServices: ["gateway"] } },
  { id: "external", module: "./never-import.ts" },
];

const planned = (options: {
  readonly selected?: string;
  readonly enabled?: boolean;
  readonly routes?: readonly string[];
  readonly feature?: boolean;
}) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)(
    options.selected === undefined ? {} : { defaultRouterService: options.selected },
  );
  const registry = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (original) =>
      PluginRegistry.of({
        ...original,
        list: Effect.map(original.list, (manifests) => [
          ...manifests,
          Schema.decodeUnknownSync(PluginManifest)({
            name: "@test/routers",
            version: "1.0.0",
            api: 4,
            contributes: {
              routerServices: contributions,
              ...(options.feature ? { appFeatures: ["mail"] } : {}),
            },
          }),
        ]),
        loadAppFeature: (id) =>
          id === "mail"
            ? Effect.succeed({
                id: "mail",
                priority: 100,
                selectors: { names: ["web"] },
                requires: { globalServices: ["mail-service"] },
                apply: () => Effect.void,
              })
            : original.loadAppFeature(id),
      }),
    ),
  ).pipe(Layer.provide(PluginRegistryLayer.layer));
  const dependencies = Layer.mergeAll(
    registry,
    Cache.layer,
    Layer.succeed(ConfigService, {
      load: Effect.succeed(config),
      get: (key) => Effect.succeed(config[key]),
    }),
  );
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: base.name,
    router: { enabled: options.enabled ?? true },
    services: {
      web: {
        type: "nginx",
        webroot: "/srv/www",
        home: false,
        appMount: false,
        ...(options.routes === undefined ? {} : { routes: options.routes }),
      },
    },
  });
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalTestLandofile(landofile, base.root), TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(dependencies)))),
  );
};

test.each([
  { name: "custom selected router", selected: "custom", id: "custom", globals: ["gateway"] },
  { name: "router without globals", selected: "external", id: "external", globals: [] },
  { name: "disabled routing", selected: "custom", enabled: false, id: undefined, globals: [] },
  { name: "route-free app", selected: "custom", routes: [], id: undefined, globals: [] },
  { name: "default Traefik", id: "traefik", globals: ["traefik"] },
  {
    name: "app-feature requirements",
    selected: "custom",
    feature: true,
    id: "custom",
    globals: ["gateway", "mail-service"],
  },
])("#1941 plans and starts $name", async (row) => {
  const plan = await planned(row);
  expect(plan.router?.id).toBe(row.id);
  expect(plan.requires?.globalServices ?? []).toEqual([...row.globals]);
  const harness = makeHarness({ plannedApp: plan, globalServiceIds: row.globals });
  let prepared = false;
  const router = {
    ...TestRouterService,
    id: row.id ?? "custom",
    prepare: () =>
      Effect.sync(() => {
        prepared = true;
      }),
  };
  await runStart(
    { ...harness, layer: Layer.merge(harness.layer, Layer.succeed(RouterService, router)) },
    plan,
  );
  expect(Object.keys(harness.globalAdmission.appliedPlan()?.services ?? {})).toEqual([...row.globals]);
  expect(prepared).toBe(row.enabled !== false && row.routes?.length !== 0);
  if (row.globals.length === 0) expect(harness.globalAdmission.appliedPlan()).toBeUndefined();
});

test("#1941 plans a routed app without a router identity when no router can be selected", async () => {
  // Given: config names a router no installed plugin contributes.
  // When: the routed app is planned.
  const plan = await planned({ selected: "missing" });

  // Then: planning still succeeds, so read-only commands keep working, and records no router.
  expect(plan.routes.length).toBeGreaterThan(0);
  expect(plan.router).toEqual({ enabled: true });
  expect(plan.requires?.globalServices ?? []).toEqual([]);
});

test("#1941 changing only the selected router invalidates a cached plan", async () => {
  const hits: boolean[] = [];
  const read = AppPlanCache.readCachedAppPlan;
  const lookup = spyOn(AppPlanCache, "readCachedAppPlan").mockImplementation((input) =>
    read(input).pipe(
      Effect.tap((plan) =>
        Effect.sync(() => {
          hits.push(plan !== null);
        }),
      ),
    ),
  );
  try {
    await planned({ selected: "custom", routes: ["cache-router.example.test"] });
    await planned({ selected: "custom", routes: ["cache-router.example.test"] });
    const second = await planned({ selected: "external", routes: ["cache-router.example.test"] });
    expect(hits).toEqual([false, true, false]);
    expect(second.router?.id).toBe("external");
    expect(second.requires?.globalServices ?? []).toEqual([]);
  } finally {
    lookup.mockRestore();
  }
});

test("#1941 legacy applied requirements remain admitted without a selected router field", async () => {
  const current = await planned({ selected: "custom" });
  const legacy = { ...current, router: { enabled: true }, requires: { globalServices: ["gateway"] } };
  const harness = makeHarness({ plannedApp: legacy, globalServiceIds: ["gateway", "test"] });
  await runStart(harness, legacy);
  expect(Object.keys(harness.globalAdmission.appliedPlan()?.services ?? {}).sort()).toEqual([
    "gateway",
    "test",
  ]);
});

test("#1941 rejects activation through a router different from the plan's selection", async () => {
  const plan = await planned({ selected: "external" });
  const harness = makeHarness({ plannedApp: plan, globalServiceIds: [] });
  const result = await Effect.runPromise(
    withGlobalConsumerAdmission({ plan }, Effect.die("A different router must not activate this plan.")).pipe(
      Effect.result,
      Effect.provide(harness.layer),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "GlobalAutoStartError",
      message: "Plan router external differs from the active router test.",
    });
});

test("#1941 restart/rebuild admission prepares a router without globals before setup and activation", async () => {
  const plan = await planned({ selected: "external" });
  const harness = makeHarness({ plannedApp: plan, globalServiceIds: [] });
  let prepared = false;
  let configured = false;
  const router = {
    ...TestRouterService,
    id: "external",
    prepare: () =>
      Effect.sync(() => {
        prepared = true;
      }),
    setup: () =>
      Effect.sync(() => {
        if (!prepared) throw new TypeError("Router setup requires preparation.");
        configured = true;
      }),
  };
  const active = await Effect.runPromise(
    withGlobalConsumerAdmission(
      { plan, setupRouter: true },
      Effect.sync(() => configured),
    ).pipe(Effect.provide(Layer.merge(harness.layer, Layer.succeed(RouterService, router)))),
  );
  expect(active).toBe(true);
  expect(harness.globalAdmission.appliedPlan()).toBeUndefined();
});

const selectionReason = new ProxyError({
  message: "Router service missing is not installed.",
  proxyId: "missing",
  remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
});
const missingRouter = makeUnavailableRouter(selectionReason);

const lifecycleTags = new Set([
  "pre-init",
  "post-init",
  "pre-start",
  "pre-restart",
  "pre-rebuild",
  "pre-stop",
]);

const runWithoutRouter = async (
  plan: AppPlan,
  operation: (target: ResolvedAppTarget) => Effect.Effect<unknown, unknown, Layer.Success<Harness["layer"]>>,
) => {
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: plan,
    globalServiceIds: ["gateway"],
    onBuildApp: () => void calls.push("build"),
    onApply: () => void calls.push("apply"),
    onStop: () => void calls.push("stop"),
    onDestroy: () => void calls.push("destroy"),
  });
  const certificates = spyOn(ServiceCertificates, "prepareServiceCertificates");
  try {
    const result = await Effect.runPromise(
      operation({ plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } }).pipe(
        Effect.result,
        Effect.provide(Layer.merge(harness.layer, Layer.succeed(RouterService, missingRouter))),
      ),
    );
    return {
      result,
      calls,
      certificatesPrepared: certificates.mock.calls.length,
      hooks: harness.events.map((event) => event._tag).filter((tag) => lifecycleTags.has(tag)),
      ensuredGlobals: Object.keys(harness.globalAdmission.appliedPlan()?.services ?? {}),
    };
  } finally {
    certificates.mockRestore();
  }
};
type Harness = ReturnType<typeof makeHarness>;

const selectionFailure = {
  _tag: "Failure",
  failure: {
    _tag: "ProxySetupError",
    proxyId: "missing",
    message: selectionReason.message,
    remediation: selectionReason.remediation,
  },
};

test.each([
  { name: "planned without a selectable router", selected: "missing" },
  { name: "applied through a router that is no longer selectable", selected: "custom" },
])(
  "#2138 routed start $name fails with the router selection reason before any work",
  async ({ selected }) => {
    // Given: a routed plan and a runtime whose configured router cannot be selected.
    const plan = await planned({ selected });

    // When
    const run = await runWithoutRouter(plan, (target) => startApp({}, target));

    // Then: the selection failure is reported before hooks, certificates, global services, builds, or apply.
    expect(run.result).toMatchObject(selectionFailure);
    expect(run).toMatchObject({ calls: [], certificatesPrepared: 0, hooks: [], ensuredGlobals: [] });
  },
);

const scoped = { services: [ServiceName.make("web")] };
test.each([
  { name: "restart", operation: (target: ResolvedAppTarget) => restartApp({}, target) },
  { name: "selected restart", operation: (target: ResolvedAppTarget) => restartApp(scoped, target) },
  { name: "rebuild", operation: (target: ResolvedAppTarget) => rebuildApp({}, target) },
  { name: "selected rebuild", operation: (target: ResolvedAppTarget) => rebuildApp(scoped, target) },
])(
  "#2138 routed $name without a selectable router refuses before stopping the running app",
  async ({ operation }) => {
    // Given: a running routed app whose configured router cannot be selected.
    const plan = await planned({ selected: "missing" });

    // When
    const run = await runWithoutRouter(plan, operation);

    // Then: nothing ran, so the app was neither stopped nor rebuilt nor reapplied.
    expect(run.result).toMatchObject(selectionFailure);
    expect(run).toMatchObject({ calls: [], certificatesPrepared: 0, hooks: [], ensuredGlobals: [] });
  },
);

test.each([
  { name: "router-disabled", enabled: false },
  { name: "route-free", routes: [] },
])("#2138 a $name start without a selectable router runs as before", async (row) => {
  // Given: a plan that publishes no routes.
  const plan = await planned({ selected: "missing", ...row });

  // When
  const run = await runWithoutRouter(plan, (target) => startApp({}, target));

  // Then: the start completes through hooks, certificates, build, and apply.
  expect(Result.isSuccess(run.result)).toBe(true);
  expect(run.calls).toEqual(expect.arrayContaining(["apply", "build"]));
  expect(run.certificatesPrepared).toBeGreaterThan(0);
  expect(run.hooks).toEqual(expect.arrayContaining(["pre-init", "pre-start"]));
});

test.each([
  {
    name: "custom router",
    plan: { router: { enabled: true, id: "custom" }, requires: { globalServices: ["gateway"] } },
    backing: ["gateway"],
  },
  { name: "router without globals", plan: { router: { enabled: true, id: "external" } }, backing: [] },
  {
    name: "legacy plan",
    plan: { router: { enabled: true }, requires: { globalServices: ["mail"] } },
    backing: ["traefik"],
  },
])("#1941 global startup starts the services backing the $name", ({ plan, backing }) => {
  expect(routerBackingServices(plan, "traefik")).toEqual(backing);
});
