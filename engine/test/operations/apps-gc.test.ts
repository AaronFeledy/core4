import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { FileSystem, type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as DiskStateStore from "@lando/state-store/service";
import { Cause, Effect, Exit, Layer } from "effect";
import { prepareAppsGc } from "../../src/operations/apps-gc.ts";
import { TeardownProvider } from "../../src/providers/app-placement.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const providerId = ProviderId.make("lando");
const at = (name: string): AppPlan => {
  const root = AbsolutePath.make(`/missing/apps-gc-${name}`);
  return {
    ...plan,
    id: AppId.make(name),
    name,
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    services: {},
    routes: [],
    fileSync: [],
  };
};

const fixture = (names: readonly string[] = ["one", "two"], retainData = false) => {
  let plans = names.map(at);
  let listed = [providerId];
  const destroyed: string[] = [];
  const fail = new Set<string>();
  const interrupt = new Set<string>();
  let launches = 0;
  let running = true;
  const provider = {
    ...TestRuntimeProvider,
    id: providerId,
    getStatus: Effect.sync(() => ({ state: running ? ("running" as const) : ("idle" as const) })),
    ensureReady: Effect.sync(() => {
      launches++;
      running = true;
    }),
    destroy: (target: Parameters<typeof TestRuntimeProvider.destroy>[0]) =>
      Effect.suspend(() => {
        if (interrupt.has(target.app)) return Effect.interrupt;
        if (fail.has(target.app))
          return Effect.fail(
            new ProviderUnavailableError({
              providerId,
              operation: "destroy",
              message: "Cleanup failed",
              remediation: "Repair provider ownership and retry.",
            }),
          );
        destroyed.push(target.app);
        plans = plans.filter((plan) => plan.id !== target.app);
        return Effect.succeed({ kind: "destroyed" as const });
      }),
  };
  const registry = RuntimeProviderRegistry.of({
    list: Effect.sync(() => listed),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
    appliedPlansFor: (root) => Effect.sync(() => plans.filter((plan) => plan.root === root)),
    resolveAppliedPlan: (root) => Effect.sync(() => plans.find((plan) => plan.root === root)),
    resolveTeardownEvidence: (root) =>
      Effect.sync(() => {
        const applied = plans.find((plan) => plan.root === root);
        return applied === undefined
          ? { kind: "absent" as const }
          : { kind: "applied" as const, plan: applied };
      }),
    observeRuntime: Effect.sync((): readonly ProviderRuntimeSnapshot[] => [
      {
        providerId,
        runtimeObserved: running,
        appliedPlans: plans,
        // The idle runtime's containers are only listed once it runs.
        services: running
          ? plans.map((plan) => ({
              app: plan.id,
              appRoot: plan.root,
              service: ServiceName.make("web"),
              providerId,
              status: "created" as const,
              publications: { status: "unknown" as const },
              containerId: `${plan.id}-web`,
            }))
          : [],
        volumes: retainData
          ? [
              {
                ref: { app: at("one").id, store: "database" },
                identity: {
                  nativeName: "one-data",
                  coordinationKey: "key",
                  generation: "1",
                  ownerRoot: at("one").root,
                  origin: "created",
                },
              },
            ]
          : [],
      },
    ]),
  });
  const harness = makeHarness();
  const layer = Layer.mergeAll(
    harness.layer,
    BunFileSystem.layer,
    Layer.succeed(RuntimeProviderRegistry, registry),
  );
  return {
    layer,
    destroyed,
    fail,
    interrupt,
    launches: () => launches,
    add: (name: string) => {
      plans.push(at(name));
    },
    changePlan: () => {
      plans = plans.map((plan) => ({ ...plan, name: "changed after confirmation" }));
    },
    idle: () => {
      running = false;
    },
    vanishUnscanned: () => {
      plans = [];
      listed = [];
    },
  };
};

test("report lists missing roots without preparing the runtime or destroying apps", async () => {
  const f = fixture();
  const { report: result } = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  expect(result.candidates.map((candidate) => candidate.apps.map(String))).toEqual([["one"], ["two"]]);
  expect(result.prune).toBe(false);
  expect(f.destroyed).toEqual([]);
  expect(f.launches()).toBe(0);
});

test.each([false, true])(
  "remaining data is intentional only when volumes were not requested: %s",
  async (volumes) => {
    const f = fixture(["one"], true);
    const prepared = await Effect.runPromise(prepareAppsGc({ volumes }).pipe(Effect.provide(f.layer)));
    const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
    expect(f.destroyed).toEqual(["one"]);
    expect(result.roots[0]?.outcome).toBe(volumes ? "retained" : "destroyed");
    if (!volumes) {
      expect(result.roots[0]?.reason).toContain("one-data");
      expect(result.roots[0]?.reason).toContain("--volumes was not set");
    }
  },
);

test("corrupt journals are reported and preserved while unrelated roots are reported and pruned", async () => {
  const base = await mkdtemp(join(tmpdir(), "lando-gc-corrupt-"));
  try {
    const paths = makeLandoPaths({ userDataRoot: join(base, "state") });
    const directory = join(paths.roots.userDataRoot, "accelerated-starts");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${"a".repeat(64)}.json`);
    await Bun.write(path, "{broken journal");
    const f = fixture();
    const layer = Layer.merge(f.layer, DiskStateStore.layerAt(paths.roots));
    const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(layer)));
    expect(prepared.report.candidates.map((candidate) => String(candidate.apps[0]))).toEqual(["one", "two"]);
    expect(prepared.report.unreadableJournals).toMatchObject([{ path, _tag: "StateStoreError" }]);
    expect(prepared.report.unreadableJournals[0]?.remediation).toContain("Preserve this journal");
    const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(layer)));
    expect(result.roots.map((root) => root.outcome)).toEqual(["destroyed", "destroyed"]);
    expect(result.unreadableJournals).toMatchObject([{ path, _tag: "StateStoreError" }]);
    expect(await Bun.file(path).text()).toBe("{broken journal");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("prune continues past a failed root and preserves roots found after confirmation", async () => {
  const f = fixture();
  const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  f.fail.add("one");
  f.add("three");
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(result.roots[1]).toMatchObject({ outcome: "destroyed" });
  expect(f.destroyed).toEqual(["two"]);
  expect(result.roots.map(({ root, outcome, confirmed }) => ({ root, outcome, confirmed }))).toEqual([
    { root: at("one").root, outcome: "failed", confirmed: true },
    { root: at("two").root, outcome: "destroyed", confirmed: true },
    { root: at("three").root, outcome: "retained", confirmed: false },
  ]);
  expect(result.roots[0]?.error).toMatchObject({
    _tag: "ProviderUnavailableError",
    remediation: "Repair provider ownership and retry.",
  });
});

test("prune does not call a root absent when its provider was not scanned again", async () => {
  const f = fixture(["one"]);
  const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  f.vanishUnscanned();
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(result.roots).toMatchObject([{ outcome: "retained", confirmed: true }]);
  expect(f.destroyed).toEqual([]);
});

test("prune confirms the holdings an idle runtime only lists once it runs", async () => {
  const f = fixture(["one"]);
  f.idle();
  const reported = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  expect(f.launches()).toBe(0);
  expect(reported.report.candidates).toMatchObject([{ runtimeObserved: false, services: [] }]);

  const prepared = await Effect.runPromise(prepareAppsGc({}, { prune: true }).pipe(Effect.provide(f.layer)));
  expect(f.launches()).toBe(1);
  expect(prepared.report.candidates).toMatchObject([{ runtimeObserved: true, services: ["one/web"] }]);
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(result.roots).toMatchObject([{ outcome: "destroyed", confirmed: true }]);
});

test("prune relaunches an owner that went idle after confirmation and still prunes", async () => {
  const f = fixture(["one"]);
  const prepared = await Effect.runPromise(prepareAppsGc({}, { prune: true }).pipe(Effect.provide(f.layer)));
  f.idle();
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(f.launches()).toBe(1);
  expect(result.roots).toMatchObject([{ outcome: "destroyed", confirmed: true }]);
});

test("prune retains a root whose folder reappeared after confirmation", async () => {
  const f = fixture(["one"]);
  const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* prepared.prune.pipe(
        Effect.provideService(FileSystem, { ...fs, exists: () => Effect.succeed(true) }),
      );
    }).pipe(Effect.provide(f.layer)),
  );
  expect(result.roots[0]).toMatchObject({ outcome: "retained", confirmed: true });
  expect(f.destroyed).toEqual([]);
});

test("a failed provider scan does not hide another provider's roots", async () => {
  const f = fixture(["one"]);
  const { report: result } = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const broken = ProviderId.make("broken");
      return yield* prepareAppsGc().pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          list: Effect.succeed([broken, providerId]),
          observeRuntime: Effect.flatMap(TeardownProvider, (id) =>
            id === broken
              ? Effect.fail(
                  new ProviderUnavailableError({
                    providerId: broken,
                    operation: "observe",
                    message: "unreadable",
                    remediation: "Repair the provider state.",
                  }),
                )
              : (registry.observeRuntime ?? Effect.succeed([])),
          ),
        }),
      );
    }).pipe(Effect.provide(f.layer)),
  );
  expect(result.candidates.map((candidate) => candidate.apps.map(String))).toEqual([["one"]]);
  expect(result.scans.map((scan) => [String(scan.providerId), scan.runtimeObserved])).toEqual([
    ["broken", false],
    ["lando", true],
  ]);
});

test("prune retains changed resource evidence even when its candidate summary is unchanged", async () => {
  const f = fixture(["one"]);
  const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  f.changePlan();
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(result.roots[0]).toMatchObject({ outcome: "retained", confirmed: true });
  expect(f.destroyed).toEqual([]);
});

test("prune preserves interruption and does not start the next root", async () => {
  const f = fixture();
  const prepared = await Effect.runPromise(prepareAppsGc().pipe(Effect.provide(f.layer)));
  f.interrupt.add("one");
  const result = await Effect.runPromiseExit(prepared.prune.pipe(Effect.provide(f.layer)));
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
  expect(f.destroyed).toEqual([]);
});

test("an answering runtime does not hide unreadable applied-state records", async () => {
  const f = fixture(["one"]);
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* prepareAppsGc().pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          appliedStateInventory: () =>
            Effect.succeed({ plans: [], unreadable: [{ path: "/private/applied-state" }] }),
        }),
      );
    }).pipe(Effect.provide(f.layer)),
  );
  expect(prepared.report.candidates).toHaveLength(1);
  expect(prepared.report.scans[0]).toMatchObject({
    runtimeObserved: true,
    complete: false,
    errorTag: "AppResolveError",
  });
});

test("an owner that cannot start does not block another owner's confirmation", async () => {
  const healthy = ProviderId.make("lando");
  const broken = ProviderId.make("broken");
  let plans = [
    { ...at("one"), provider: healthy },
    { ...at("two"), provider: broken },
  ];
  let running = false;
  const launchFailure = new ProviderUnavailableError({
    providerId: broken,
    operation: "ensureReady",
    message: "Runtime cannot start.",
    remediation: "Repair the runtime.",
  });
  const providerFor = (id: ProviderId) => ({
    ...TestRuntimeProvider,
    id,
    getStatus: Effect.sync(() => ({
      state: id === healthy && running ? ("running" as const) : ("idle" as const),
    })),
    ensureReady:
      id === healthy
        ? Effect.sync(() => {
            running = true;
          })
        : Effect.fail(launchFailure),
    destroy: (target: Parameters<typeof TestRuntimeProvider.destroy>[0]) =>
      Effect.sync(() => {
        plans = plans.filter((plan) => plan.id !== target.app);
        return { kind: "destroyed" as const };
      }),
  });
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([healthy, broken]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: (target) =>
      Effect.succeed(providerFor(typeof target === "string" ? target : (target?.provider ?? healthy))),
    appliedPlansFor: (root, providerId) =>
      Effect.sync(() =>
        plans.filter(
          (plan) => plan.root === root && (providerId === undefined || plan.provider === providerId),
        ),
      ),
    resolveAppliedPlan: (root) => Effect.sync(() => plans.find((plan) => plan.root === root)),
    resolveTeardownEvidence: (root) =>
      Effect.sync(() => {
        const applied = plans.find((plan) => plan.root === root);
        return applied === undefined
          ? { kind: "absent" as const }
          : { kind: "applied" as const, plan: applied };
      }),
    observeRuntime: Effect.sync((): readonly ProviderRuntimeSnapshot[] =>
      [healthy, broken].map((id) => {
        const owned = plans.filter((plan) => plan.provider === id);
        const observed = id === healthy && running;
        return {
          providerId: id,
          runtimeObserved: observed,
          appliedPlans: owned,
          services: observed
            ? owned.map((plan) => ({
                app: plan.id,
                appRoot: plan.root,
                service: ServiceName.make("web"),
                providerId: id,
                status: "created" as const,
                publications: { status: "unknown" as const },
                containerId: `${plan.id}-web`,
              }))
            : [],
          volumes: [],
        };
      }),
    ),
  });
  const layer = Layer.mergeAll(
    makeHarness().layer,
    BunFileSystem.layer,
    Layer.succeed(RuntimeProviderRegistry, registry),
  );

  const prepared = await Effect.runPromise(prepareAppsGc({}, { prune: true }).pipe(Effect.provide(layer)));
  expect(prepared.report.candidates).toMatchObject([
    { root: at("one").root, runtimeObserved: true, services: ["one/web"] },
    { root: at("two").root, runtimeObserved: false },
  ]);
  const result = await Effect.runPromise(prepared.prune.pipe(Effect.provide(layer)));
  expect(result.roots).toMatchObject([
    { root: at("one").root, outcome: "destroyed" },
    { root: at("two").root, outcome: "failed", error: { message: "Runtime cannot start." } },
  ]);
});
