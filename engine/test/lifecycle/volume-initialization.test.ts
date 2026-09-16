import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type VolumeIdentity,
} from "@lando/sdk/schema";
import { StateStore, type StateStoreShape } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { withPlanVolumeCoordination } from "../../src/lifecycle/volume-coordination.ts";
import { recordCreatedVolumes } from "../../src/lifecycle/volume-initialization.ts";

const identity: VolumeIdentity = {
  coordinationKey: "daemon/data",
  nativeName: "data",
  generation: "one",
  ownerRoot: AbsolutePath.make("/owner"),
  origin: "created",
};
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: AppId.make("test"),
  name: "test",
  slug: "test",
  root: identity.ownerRoot,
  provider: ProviderId.make("test"),
  identity: { appRoot: identity.ownerRoot, ownerKey: "owner" },
  services: {
    [ServiceName.make("db")]: {
      name: ServiceName.make("db"),
      type: "mysql",
      provider: ProviderId.make("test"),
      primary: true,
      artifact: { kind: "ref", ref: "mysql:8" },
      environment: {},
      mounts: [],
      storage: [{ store: "data", target: PortablePath.make("/var/lib/mysql"), readOnly: false }],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test.each(["created", "existing", "adopted", "replaced"] as const)(
  "apply evidence for %s volumes is fail-closed",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-creation-test-"));
    try {
      const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
      const store: StateStoreShape = {
        open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
        withLock: (_key, body) => body,
      };
      let observations = 0;
      const provider = {
        id: "test",
        observeVolume: () =>
          Effect.sync(() => {
            observations += 1;
            return {
              ref: { app: plan.id, store: "data" },
              identity: {
                ...identity,
                origin: kind === "adopted" ? ("adopted" as const) : ("created" as const),
                generation: kind === "replaced" && observations > 1 ? "two" : "one",
              },
            };
          }),
      };
      await Effect.runPromise(
        recordCreatedVolumes(provider, plan, {
          changed: true,
          createdVolumes: kind === "existing" ? [] : [identity],
        }).pipe(Effect.provideService(StateStore, store)),
      );
      const state = await Effect.runPromise(volumeInitialization(store, identity));
      expect((await Effect.runPromise(state.read))?.state._tag ?? "unknown").toBe(
        kind === "created" ? "fresh" : "unknown",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("created-volume persistence reuses the active lifecycle volume lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-creation-lock-test-"));
  try {
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
    let lockCalls = 0;
    const store: StateStoreShape = {
      open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
      withLock: (_key, body) =>
        Effect.sync(() => {
          lockCalls += 1;
        }).pipe(Effect.zipRight(body)),
    };
    const coordinatedPlan: AppPlan = {
      ...plan,
      stores: [{ name: "data", scope: "service", kind: "data" }],
    };
    const provider = {
      id: "test",
      locateVolume: () =>
        Effect.succeed({ coordinationKey: identity.coordinationKey, nativeName: identity.nativeName }),
      observeVolume: () => Effect.succeed({ ref: { app: plan.id, store: "data" }, identity }),
    };

    await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: coordinatedPlan,
        provider,
        stateStore: store,
        body: () =>
          recordCreatedVolumes(provider, coordinatedPlan, {
            changed: true,
            createdVolumes: [identity],
          }).pipe(Effect.provideService(StateStore, store)),
      }),
    );

    expect(lockCalls).toBe(1);
    const state = await Effect.runPromise(volumeInitialization(store, identity));
    expect((await Effect.runPromise(state.read))?.state._tag).toBe("fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
