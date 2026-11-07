import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";
import { resolveDesiredAppTarget } from "@lando/engine/landofile/app-resolution";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withScenarioRuntimeOverride } from "../../src/runtime/scenario-override.ts";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";

// Scenario commands run the real CLI, including real starts that wait out service readiness.
setDefaultTimeout(30_000);

const planAt = (id: string, appRoot: AbsolutePath): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root: appRoot,
  identity: { appRoot, ownerKey: `${id}-owner` },
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
    source: "scenario-provider-dispatch.test",
    runtime: 4,
  },
  extensions: {},
});

type ScenarioProvider = ReturnType<typeof makeScenarioProvider>;

// Plans a fixture through the real planner and applies it, as `lando start` does.
const planAndApply = async (provider: ScenarioProvider, root: string): Promise<AppPlan> => {
  await import("../../src/runtime/bundled-plugins.ts");
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const target = await withScenarioRuntimeOverride(
      { providerRegistry: provider.layer, hostServices: provider.hostServices, observeEvent: () => {} },
      () =>
        Effect.runPromise(
          resolveDesiredAppTarget.pipe(
            Effect.provide(
              makeLandoRuntime({ bootstrap: "app", cwd: root, plugins: { policy: "bundled-only" } }),
            ),
          ),
        ),
    );
    await Effect.runPromise(Effect.scoped(provider.provider.apply(target.plan, { reconcile: false })));
    return target.plan;
  } finally {
    process.chdir(previousCwd);
  }
};

test.each([
  ["solr", "/home/solr"],
  ["elasticsearch", "/usr/share/elasticsearch"],
] as const)("keeps the %s fixture's prepared home in the applied record", async (guideId, homeTarget) => {
  await Effect.runPromise(
    withScenarioContext({ guideId, scenarioId: "prepared-home-plan" }, (context) =>
      Effect.gen(function* () {
        // Given: a real guide fixture requiring a prepared catalog home.
        const root = yield* context.fixtures.use(`${guideId}-demo`);
        const provider = makeScenarioProvider();

        // When: the fixture is planned and applied.
        yield* Effect.tryPromise(() => planAndApply(provider, root));

        // Then: applied-state observation retains the home and its ownership build intent.
        const registry = yield* RuntimeProviderRegistry.pipe(Effect.provide(provider.layer));
        const applied = yield* registry.resolveAppliedPlan(AbsolutePath.make(root));
        const search = applied?.services[ServiceName.make("search")];
        expect(search?.home).toMatchObject({ state: "persisted", target: homeTarget, user: guideId });
        expect(search?.extensions["@lando/core/service-features"]).toMatchObject({
          buildSteps: expect.arrayContaining([
            expect.objectContaining({ id: "lando.storage:own-data-trees", phase: "build", user: "root" }),
          ]),
        });
        const selected = yield* registry.select(applied);
        expect(yield* registry.capabilities).toBe(selected.capabilities);
        expect(selected.capabilities).toBe(provider.provider.capabilities);
      }),
    ),
  );
});

test("uses the test runtime provider for exec when a guide uses the scenario harness", async () => {
  const result = await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "test-provider-exec" }, (context) =>
      Effect.gen(function* () {
        // Given: a provider:test guide fixture started through the real CLI.
        yield* context.fixtures.use("exec-demo");
        yield* context.runCli(["start"]);

        // When: the same guide invokes the real app:exec CLI path.
        return yield* context.runCli(["exec", "--", "echo", "hello"]);
      }),
    ),
  );

  // Then: exec is dispatched through TestRuntimeProvider rather than a live provider registry.
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("echo hello\n");
  expect(result.stderr).toBe("");
});

test("observes the scenario's applied plan after its desired Landofile becomes invalid", async () => {
  const result = await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "applied-info" }, (context) =>
      Effect.gen(function* () {
        // Given: a started app whose desired configuration no longer parses.
        const root = yield* context.fixtures.use("exec-demo");
        const started = yield* context.runCli(["start"]);
        expect(started.exitCode).toBe(0);
        yield* Effect.tryPromise(() => Bun.write(join(root, ".lando.yml"), "services: [invalid\n"));

        // When: info observes the app through the real CLI dispatcher.
        return yield* context.runCli(["info", "--format=json"]);
      }),
    ),
  );

  // Then: the applied app remains observable without planning the invalid desired state.
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { app: "exec-demo" } });
});

test("resolves the applied plan when later commands use a symlink alias of the root", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "alias-applied-plan" }, (context) =>
      Effect.gen(function* () {
        // Given: applied state stored under the planner's canonical root.
        const root = yield* context.fixtures.use("exec-demo");
        const alias = join(context.testDir, "linked-app");
        yield* Effect.tryPromise(() => symlink(root, alias, "dir"));
        const provider = makeScenarioProvider();
        yield* Effect.tryPromise(() => planAndApply(provider, root));

        // When: a later command resolves applied state through the alias path.
        const planned = yield* Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          return yield* registry.resolveAppliedPlan(AbsolutePath.make(alias));
        }).pipe(Effect.provide(provider.layer));

        // Then: the alias still finds the realization, the way production ancestor matching does.
        expect(planned?.root).toBeDefined();
        expect(planned?.id).toBe(AppId.make("exec-demo"));
      }),
    ),
  );
});

test("prefers the longest matching applied plan the way production ancestor matching does", async () => {
  const provider = makeScenarioProvider();
  const parent = planAt("parent-app", AbsolutePath.make("/tmp/scenario-parent"));
  const child = planAt("child-app", AbsolutePath.make("/tmp/scenario-parent/child"));
  await Effect.runPromise(Effect.scoped(provider.provider.apply(parent, { reconcile: false })));
  await Effect.runPromise(Effect.scoped(provider.provider.apply(child, { reconcile: false })));

  const planned = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry.resolveAppliedPlan(AbsolutePath.make("/tmp/scenario-parent/child/nested"));
    }).pipe(Effect.provide(provider.layer)),
  );

  expect(planned?.id).toBe(AppId.make("child-app"));
});

test("forgets the applied plan when destroy runs from a symlink to its root", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "symlink-destroy" }, (context) =>
      Effect.gen(function* () {
        // Given: an app started from its canonical root and an alias to that root.
        const root = yield* context.fixtures.use("exec-demo");
        const alias = join(context.testDir, "linked-app");
        yield* Effect.tryPromise(() => symlink(root, alias, "dir"));
        const provider = makeScenarioProvider();
        const plan = yield* Effect.tryPromise(() => planAndApply(provider, alias));

        // When: destroy removes the app's applied state.
        yield* provider.provider.destroy({ app: plan.id, plan }, { volumes: false });

        // Then: both observation and teardown agree that the realization is absent.
        const evidence = yield* Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          return yield* Effect.all({
            applied: registry.resolveAppliedPlan(AbsolutePath.make(root)),
            teardown: registry.resolveTeardownEvidence(AbsolutePath.make(root)),
            placement: registry.appliedPlansFor(AbsolutePath.make(root)),
          });
        }).pipe(Effect.provide(provider.layer));
        expect(evidence).toEqual({ applied: undefined, teardown: { kind: "absent" }, placement: [] });
      }),
    ),
  );
});

test("keeps teardown and placement exact when observation finds an ancestor", async () => {
  const provider = makeScenarioProvider();
  const parent = planAt("parent-app", AbsolutePath.make("/tmp/scenario-exact"));
  const nested = AbsolutePath.make("/tmp/scenario-exact/nested");
  await Effect.runPromise(Effect.scoped(provider.provider.apply(parent, { reconcile: false })));
  const evidence = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* Effect.all({
        applied: registry.resolveAppliedPlan(nested),
        teardown: registry.resolveTeardownEvidence(nested),
        placement: registry.appliedPlansFor(nested),
      });
    }).pipe(Effect.provide(provider.layer)),
  );
  expect(evidence).toMatchObject({ applied: { id: parent.id }, teardown: { kind: "absent" }, placement: [] });
  expect((await Effect.runPromise(provider.appliedPlans)).map((plan) => plan.id)).toEqual([parent.id]);
});

test("does not inherit a lexical ancestor when a symlink leads outside its app", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "redirected-symlink" }, (context) =>
      Effect.gen(function* () {
        const root = yield* context.fixtures.use("exec-demo");
        const outside = join(context.testDir, "outside");
        const alias = join(root, "linked-outside");
        yield* Effect.tryPromise(() => mkdir(outside));
        yield* Effect.tryPromise(() => symlink(outside, alias, "dir"));
        const provider = makeScenarioProvider();
        yield* Effect.tryPromise(() => planAndApply(provider, root));
        const evidence = yield* Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          return yield* Effect.all({
            applied: registry.resolveAppliedPlan(AbsolutePath.make(alias)),
            teardown: registry.resolveTeardownEvidence(AbsolutePath.make(alias)),
            placement: registry.appliedPlansFor(AbsolutePath.make(alias)),
          });
        }).pipe(Effect.provide(provider.layer));
        expect(evidence).toEqual({ applied: undefined, teardown: { kind: "absent" }, placement: [] });
      }),
    ),
  );
});

test("records the applied plan as its encoded, hook-free applied-state record", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "events", scenarioId: "applied-record" }, (context) =>
      Effect.gen(function* () {
        // Given: a planned app with Landofile events.
        const root = yield* context.fixtures.use("events-demo");
        const provider = makeScenarioProvider();

        // When: the plan is applied.
        const planned = yield* Effect.tryPromise(() => planAndApply(provider, root));
        const [recorded] = yield* provider.appliedPlans;

        // Then: later reads see a decoded copy without the hooks, like real applied state.
        expect(Object.keys(planned.events ?? {}).length).toBeGreaterThan(0);
        expect(recorded?.id).toBe(planned.id);
        expect(recorded).not.toBe(planned);
        expect(recorded !== undefined && "events" in recorded).toBe(false);
      }),
    ),
  );
});

test("observes only the containers its apply, stop, and destroy produced", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "observed-containers" }, (context) =>
      Effect.gen(function* () {
        const root = yield* context.fixtures.use("exec-demo");
        const provider = makeScenarioProvider();
        const statuses = () =>
          provider.provider
            .list({ app: AppId.make("exec-demo") })
            .pipe(
              Effect.map((services) =>
                services.map((service): ReadonlyArray<string> => [String(service.service), service.status]),
              ),
            );

        // Given: nothing applied yet.
        expect(yield* statuses()).toEqual([]);

        // When / Then: apply runs every planned service, stop exits one, destroy removes them all.
        const plan = yield* Effect.tryPromise(() => planAndApply(provider, root));
        const services = Object.keys(plan.services);
        expect(yield* statuses()).toEqual(services.map((service) => [service, "running"]));
        const [first] = services;
        if (first === undefined) throw new Error("exec-demo plans no services");
        yield* provider.provider.stop({ app: plan.id, service: ServiceName.make(first) });
        expect(yield* statuses()).toEqual(
          services.map((service) => [service, service === first ? "exited" : "running"]),
        );
        yield* provider.provider.destroy({ app: plan.id, plan }, { volumes: false });
        expect(yield* statuses()).toEqual([]);
        expect(yield* provider.appliedPlans).toEqual([]);
      }),
    ),
  );
});
