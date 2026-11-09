import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, type VolumeInfo, appIdentityKey } from "@lando/sdk/schema";
import { type ProviderRuntimeSnapshot, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { clearAppDataIdentityWhenComplete } from "../../src/operations/data-identity-clear.ts";
import { executeTeardown } from "../../src/operations/destroy-execute.ts";
import type { TeardownPlan } from "../../src/operations/destroy-plan.ts";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { readAppDataIdentity, recordAppDataIdentity } from "../../src/planner/data-identity.ts";
import { TeardownProvider } from "../../src/providers/app-placement.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { identity, identityPlan, identityRegistry, identityTarget, root } from "./data-identity-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const volume: VolumeInfo = {
  ref: { app: AppId.make("original"), store: "db" },
  labels: { "dev.lando.volume-owner": root },
};
const snapshot = (
  observed: boolean,
  volumes: readonly VolumeInfo[],
  provider = "lando",
): ProviderRuntimeSnapshot => ({
  providerId: ProviderId.make(provider),
  runtimeObserved: observed,
  appliedPlans: [],
  services: [],
  volumes,
});

test("provider-scoped teardown cannot clear a sibling provider's data identity", async () => {
  const store = makeTestStateStore();
  await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
  const registry = {
    ...identityRegistry(),
    observeRuntime: Effect.gen(function* () {
      const selected = yield* TeardownProvider;
      return selected === undefined
        ? [snapshot(true, []), snapshot(true, [volume], "docker")]
        : [snapshot(true, [])];
    }),
  };
  await Effect.runPromise(
    clearAppDataIdentityWhenComplete({ root, volumesRequested: true }).pipe(
      Effect.provide(store.layer),
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(TeardownProvider, ProviderId.make("lando")),
    ),
  );
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual({
    name: "original",
  });
});

test.each([
  {
    name: "another provider still owns data",
    snapshots: [snapshot(true, []), snapshot(true, [volume], "docker")],
    clear: false,
  },
  { name: "a runtime could not be observed", snapshots: [snapshot(false, [])], clear: false },
  { name: "no provider evidence exists", snapshots: [], clear: false },
  {
    name: "only caches remain",
    snapshots: [
      snapshot(true, [{ ...volume, labels: { ...volume.labels, "dev.lando.storage-kind": "cache" } }]),
    ],
    clear: true,
  },
  { name: "all data is already absent", snapshots: [snapshot(true, [])], clear: true },
])("clears only with complete volume absence: $name", async ({ snapshots, clear }) => {
  const store = makeTestStateStore();
  await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
  await Effect.runPromise(
    clearAppDataIdentityWhenComplete({ root, volumesRequested: true }).pipe(
      Effect.provide(store.layer),
      Effect.provideService(RuntimeProviderRegistry, identityRegistry([], snapshots)),
    ),
  );
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual(
    clear ? null : { name: "original" },
  );
});

test.each([undefined, "inventory", "orphans"] as const)(
  "missing-root teardown clears an already empty record with %s evidence",
  async (evidence) => {
    const missingRoot = AbsolutePath.make(`${root}/missing`);
    const missingIdentity = { appRoot: missingRoot, ownerKey: appIdentityKey("owner", missingRoot) };
    const store = makeTestStateStore();
    await Effect.runPromise(
      recordAppDataIdentity(missingIdentity, "original").pipe(Effect.provide(store.layer)),
    );
    const plan = identityPlan("current", "original");
    const hints = {
      appRoot: missingRoot,
      ownerKey: missingIdentity.ownerKey,
      providerId: plan.provider,
      appIds: [plan.id],
    };
    const teardown: TeardownPlan = {
      evidence,
      root: missingRoot,
      name: "missing",
      refs: evidence === undefined ? [] : [{ kind: "user", id: plan.id, root: missingRoot }],
      applied: undefined,
      authored: undefined,
      retained: undefined,
      target: undefined,
      groups:
        evidence === "orphans"
          ? [{ providerId: plan.provider, appId: plan.id, services: [], volumes: [] }]
          : [],
      inventory: evidence === "inventory" ? [hints] : [],
      snapshots: [],
      followUpOrphans: false,
      options: { volumes: true },
    };
    const harness = makeHarness({
      plannedApp: plan,
      stateStore: store,
      listVolumes: () => Effect.succeed([]),
      providerOverrides: {
        getStatus: Effect.succeed({ state: "running" as const }),
        cleanupOwnedResources: () =>
          Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 }),
      },
    });
    await Effect.runPromise(executeTeardown(teardown).pipe(Effect.provide(harness.layer)));
    expect(
      await Effect.runPromise(readAppDataIdentity(missingIdentity).pipe(Effect.provide(store.layer))),
    ).toBeNull();
  },
);

test.each([
  { name: "plain", options: {}, remaining: [], skipped: false, clear: false },
  { name: "cache-only", options: { purgeCaches: true }, remaining: [], skipped: false, clear: false },
  { name: "volumes", options: { volumes: true }, remaining: [], skipped: false, clear: true },
  { name: "partial cleanup", options: { volumes: true }, remaining: [], skipped: true, clear: false },
  {
    name: "volume removal flag with remaining data",
    options: { volumes: true },
    remaining: [volume],
    skipped: false,
    clear: false,
  },
])(
  "destroy $name retains or clears the record from cleanup evidence",
  async ({ options, remaining, skipped, clear }) => {
    const plan = identityPlan("current", "original");
    const store = makeTestStateStore();
    await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
    const ownership = {
      appRoot: root,
      ownerKey: identity.ownerKey,
      providerId: plan.provider,
      appIds: [plan.id],
    };
    const harness = makeHarness({
      plannedApp: plan,
      stateStore: store,
      appliedPlans: [plan],
      listVolumes: () => Effect.succeed(remaining),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan, ownership: [ownership] }),
      providerOverrides: {
        getStatus: Effect.succeed({ state: "running" as const }),
        cleanupOwnedResources: () =>
          Effect.succeed({
            servicesRemoved: [],
            networksRemoved: 0,
            volumesRemoved: 0,
            ...(skipped
              ? { skipped: [{ appId: plan.id, resource: "db", reason: "unreadable" as const }] }
              : {}),
          }),
      },
    });
    await Effect.runPromise(
      destroyAppForTarget(options, identityTarget(plan)).pipe(Effect.provide(harness.layer)),
    );
    expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual(
      clear ? null : { name: "original" },
    );
  },
);

test.each([
  { name: "no inventory for the folder", ownership: Effect.succeed(undefined), clear: true },
  {
    name: "an inventory for the folder",
    ownership: Effect.succeed({
      appRoot: root,
      ownerKey: appIdentityKey("owner", root),
      providerId: ProviderId.make("docker"),
      appIds: [AppId.make("original")],
    }),
    clear: false,
  },
  {
    name: "an unreadable inventory",
    ownership: Effect.fail(
      new ProviderUnavailableError({
        providerId: "docker",
        operation: "resource-ownership",
        message: "Inventory unreadable.",
        remediation: "Repair the inventory.",
      }),
    ),
    clear: false,
  },
])("an unobserved provider blocks clearing only with $name", async ({ ownership, clear }) => {
  const store = makeTestStateStore();
  await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
  const registry = {
    ...identityRegistry([], [snapshot(true, []), snapshot(false, [], "docker")]),
    resourceOwnership: () => ownership,
  };
  await Effect.runPromise(
    clearAppDataIdentityWhenComplete({ root, volumesRequested: true }).pipe(
      Effect.provide(store.layer),
      Effect.provideService(RuntimeProviderRegistry, registry),
    ),
  );
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual(
    clear ? null : { name: "original" },
  );
});
