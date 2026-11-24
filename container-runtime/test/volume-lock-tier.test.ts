import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PHYSICAL_VOLUME_LOCK_TIER,
  type PhysicalVolumeLockTier,
  ProviderId,
  appIdentityKey,
  landoDependencyEnvironmentStoreName,
  physicalVolumeLockTier,
} from "@lando/sdk/schema";
import { makeTestStateStore } from "@lando/state-store/testing";
import { heldVolumeLocks, withPhysicalVolumeLocks } from "@lando/state-store/volume-lock";
import { DateTime, Effect } from "effect";

import { planInventoryVolumeDeletions } from "../src/inventory-volume-deletions.ts";
import { podmanVolumeCreationLabels } from "../src/podman/bring-up.ts";
import { planVolumeDeletions } from "../src/podman/plan-volume-deletions.ts";
import { type OwnedResource, makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { ownedVolumeLockTier } from "../src/volume-ownership.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "container-runtime/volume-lock-tier.test.ts",
  runtime: 4 as const,
};

const pluginStore = { name: "lando-ssh-agent", scope: "app", kind: "data" } as const;
const dependencyStore = {
  name: landoDependencyEnvironmentStoreName("app", "composer", "a".repeat(40)),
  scope: "app",
  kind: "data",
} as const;

const globalRoot = AbsolutePath.make("/data/global");
const appRoot = AbsolutePath.make("/apps/app");

const globalPlan: AppPlan = {
  valueModel: 1,
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: globalRoot,
  provider: ProviderId.make("podman"),
  identity: {
    appRoot: globalRoot,
    ownerKey: appIdentityKey("owner", globalRoot),
    dataRoot: AbsolutePath.make("/data/local"),
  },
  services: {},
  routes: [],
  stores: [pluginStore],
  fileSync: [],
  metadata,
  extensions: {},
};

const appPlan: AppPlan = {
  valueModel: 1,
  id: AppId.make("app"),
  name: "app",
  slug: "app",
  root: appRoot,
  provider: ProviderId.make("podman"),
  identity: {
    appRoot,
    ownerKey: appIdentityKey("owner", appRoot),
    dataRoot: AbsolutePath.make("/data/local"),
  },
  services: {},
  routes: [],
  stores: [dependencyStore],
  fileSync: [],
  metadata,
  extensions: {},
};

const volumeLabels = (plan: AppPlan, store: AppPlan["stores"][number]) => ({
  ...podmanVolumeCreationLabels(plan, store),
  "dev.lando.app": plan.id,
  "dev.lando.scope": store.scope,
  "dev.lando.store": store.name,
  "dev.lando.volume-instance": "generation",
});

const runtimeFor = (plan: AppPlan, store: AppPlan["stores"][number]) => ({
  ctx: { providerId: plan.provider, remediation: "Retry.", env: {} },
  endpointNamespace: "test-daemon",
  request: (request: { method: string; path: string }) =>
    Effect.sync(() => {
      const labels = volumeLabels(plan, store);
      if (request.path === "/volumes")
        return { status: 200, body: JSON.stringify({ Volumes: [{ Name: store.name, Labels: labels }] }) };
      if (request.path === `/volumes/${encodeURIComponent(store.name)}`)
        return { status: 200, body: JSON.stringify({ Name: store.name, Labels: labels }) };
      if (request.method === "DELETE") return { status: 204, body: "" };
      return { status: 404, body: "{}" };
    }),
});

const effectiveTier = (name: string, tier: PhysicalVolumeLockTier | undefined): PhysicalVolumeLockTier =>
  tier ?? physicalVolumeLockTier(name);

const lockRequestTier = async (name: string, tier: PhysicalVolumeLockTier | undefined) => {
  const store = makeTestStateStore();
  return Effect.runPromise(
    withPhysicalVolumeLocks(
      store.service,
      [
        {
          key: JSON.stringify(["endpoint:test-daemon", name]),
          name,
          mode: "exclusive" as const,
          resource: `volume ${name}`,
          ...(tier === undefined ? {} : { tier }),
        },
      ],
      heldVolumeLocks.pipe(Effect.map((held) => [...held.values()].map((entry) => entry.tier))),
    ),
  );
};

const tierCases = [
  {
    label: "plugin explicit global",
    plan: globalPlan,
    store: pluginStore,
    expected: PHYSICAL_VOLUME_LOCK_TIER.globalApp,
  },
  {
    label: "dependency environment",
    plan: appPlan,
    store: dependencyStore,
    expected: PHYSICAL_VOLUME_LOCK_TIER.default,
  },
] as const;

describe("volume lock tier parity", () => {
  test("plugin explicit global store needs plan-owned tier, not the name classifier", () => {
    // Name alone ranks as ordinary storage; the global app owner promotes it.
    expect(physicalVolumeLockTier(pluginStore.name)).toBe(PHYSICAL_VOLUME_LOCK_TIER.default);
    expect(ownedVolumeLockTier(globalPlan.id, false)).toBe(PHYSICAL_VOLUME_LOCK_TIER.globalApp);
    expect(ownedVolumeLockTier(appPlan.id, false)).toBeUndefined();
  });

  test.each(tierCases)(
    "planful deletion candidates lock $label at the activation tier",
    async ({ plan, store, expected }) => {
      const runtime = runtimeFor(plan, store);
      const planned = await Effect.runPromise(planVolumeDeletions(runtime, plan, { volumes: true }));
      expect(planned.candidates).toHaveLength(1);
      const candidate = planned.candidates[0];
      expect(candidate).toBeDefined();
      if (candidate === undefined) return;
      expect(candidate.name).toBe(store.name);
      expect(candidate.tier).toEqual(ownedVolumeLockTier(plan.id, false));
      expect(effectiveTier(candidate.name, candidate.tier)).toBe(expected);
      expect(await lockRequestTier(candidate.name, candidate.tier)).toEqual([expected]);
    },
  );

  test.each(tierCases)(
    "recorded inventory deletion locks $label at the same tier as planful deletion",
    async ({ plan, store, expected }) => {
      const runtime = runtimeFor(plan, store);
      const identity = plan.identity;
      expect(identity).toBeDefined();
      if (identity === undefined) return;
      const resource: OwnedResource = {
        kind: "volume",
        nativeName: store.name,
        appId: plan.id,
        appRoot: plan.root,
        ownerKey: identity.ownerKey,
        providerId: plan.provider,
        ...(identity.dataRoot === undefined ? {} : { dataRoot: identity.dataRoot }),
        volumeClass: "data",
        volumeScope: store.scope,
        identityDigest: "digest",
      };
      const recorded = await Effect.runPromise(
        planInventoryVolumeDeletions({
          root: plan.root,
          resources: [resource],
          options: { volumes: true },
          coverage: undefined,
          runtime,
          store: makeResourceOwnershipStore(plan.provider),
          skipped: [],
          receipts: [],
        }),
      );
      expect(recorded.candidates).toHaveLength(1);
      const candidate = recorded.candidates[0];
      expect(candidate).toBeDefined();
      if (candidate === undefined) return;
      expect(candidate.tier).toEqual(ownedVolumeLockTier(plan.id, false));
      expect(effectiveTier(candidate.name, candidate.tier)).toBe(expected);

      const planful = await Effect.runPromise(planVolumeDeletions(runtime, plan, { volumes: true }));
      expect(planful.candidates[0]?.tier).toEqual(candidate.tier);
      expect(planful.candidates[0]?.name).toBe(candidate.name);
      expect(await lockRequestTier(candidate.name, candidate.tier)).toEqual([expected]);
    },
  );
});
