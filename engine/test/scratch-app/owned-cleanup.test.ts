import { expect, test } from "bun:test";
import {
  makeOwnedResourcesCleanup,
  makeResourceOwnershipStore,
} from "@lando/container-runtime/provider-assembly";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { DateTime, Effect } from "effect";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { cleanupScratchOwnedState } from "../../src/scratch-app/owned-cleanup.ts";

const root = AbsolutePath.make("/data/scratch/scratch-cwd-111111/root");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
  source: "test",
  runtime: 4 as const,
};

test("cleanupScratchOwnedState retires only a proven-absent volume generation and skips keep-volumes", async () => {
  const stateStore = makeTestStateStore();
  const identity = {
    coordinationKey: JSON.stringify(["endpoint:test", "data"]),
    nativeName: "data",
    generation: "one",
    ownerRoot: root,
    origin: "created" as const,
  };
  const initialization = await Effect.runPromise(volumeInitialization(stateStore.service, identity));
  await Effect.runPromise(initialization.recordCreation);
  const plan = {
    id: AppId.make("scratch-cwd-111111"),
    name: "scratch-cwd-111111",
    slug: "scratch-cwd-111111",
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    provider: ProviderId.make("lando"),
    services: {
      [ServiceName.make("web")]: {
        name: ServiceName.make("web"),
        type: "compose",
        provider: ProviderId.make("lando"),
        primary: true,
        artifact: { kind: "ref" as const, ref: "alpine:3.20" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    stores: [{ name: "data", scope: "app" as const, kind: "data" as const }],
    routes: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  let volumeExists = true;
  const provider = {
    ...TestRuntimeProvider,
    locateVolume: (ref: { store: string }) =>
      Effect.succeed(
        volumeExists
          ? {
              coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
              nativeName: ref.store,
              presence: "present" as const,
            }
          : {
              coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
              nativeName: ref.store,
              presence: "absent" as const,
            },
      ),
  };
  expect(planDataId(plan)).toBe(plan.id);
  const provide = <A, E>(effect: Effect.Effect<A, E, StateStore | RuntimeProviderRegistry>) =>
    effect.pipe(
      Effect.provideService(StateStore, stateStore.service),
      Effect.provideService(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({ select: () => Effect.succeed(provider) }),
      ),
    );
  await Effect.runPromise(provide(cleanupScratchOwnedState({ plan, provider, keepVolumes: true })));
  expect((await Effect.runPromise(initialization.read))?.state._tag).toBe("fresh");
  // A volume the cleanup could not remove keeps its receipt for the retry.
  await Effect.runPromise(provide(cleanupScratchOwnedState({ plan, provider, keepVolumes: false })));
  expect((await Effect.runPromise(initialization.read))?.state._tag).toBe("fresh");
  volumeExists = false;
  await Effect.runPromise(provide(cleanupScratchOwnedState({ plan, provider, keepVolumes: false })));
  expect(await Effect.runPromise(initialization.read)).toBeNull();
});

test("cleanupScratchOwnedState releases a pre-#2731 cwd scratch's shared cache member from its source app's inventory (#2743)", async () => {
  // Given a source app inventory that also records a cwd scratch's data volume and shared cache.
  const sourceRoot = AbsolutePath.make("/apps/source");
  const providerId = ProviderId.make("test");
  const stateStore = makeTestStateStore();
  const store = makeResourceOwnershipStore(
    providerId,
    makePluginStateStore(stateStore.service, AbsolutePath.make("/state"), {
      enforce: async () => undefined,
      verify: async () => undefined,
    }),
  );
  const planAt = (id: string, stores: AppPlan["stores"], extensions: AppPlan["extensions"]): AppPlan => ({
    id: AppId.make(id),
    name: id,
    slug: id,
    provider: providerId,
    root: sourceRoot,
    identity: planAppIdentity({ root: sourceRoot }),
    services: {},
    routes: [],
    stores,
    fileSync: [],
    extensions,
    metadata,
  });
  const source = planAt("source", [{ name: "data", kind: "data", scope: "app" }], {});
  const scratchId = "scratch-cwd-222222";
  const scratch = planAt(
    scratchId,
    [
      { name: "data", kind: "data", scope: "app" },
      { name: "lando-cache-composer", kind: "cache", scope: "global" },
    ],
    { [SCRATCH_EXTENSION_KEY]: { id: scratchId } },
  );
  await Effect.runPromise(Effect.all([store.prepare(source), store.prepare(scratch)]));
  const requests: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "test",
    locateVolume: (ref: { store: string }) =>
      Effect.succeed({ coordinationKey: ref.store, nativeName: ref.store, presence: "absent" as const }),
    cleanupOwnedResources: makeOwnedResourcesCleanup({
      ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
      endpointNamespace: "test-daemon",
      store,
      api: {
        request: ({ method, path }) =>
          Effect.sync(() => {
            requests.push(`${method} ${path}`);
            return { status: 404, body: "" };
          }),
      },
    }),
  };

  // When the scratch's owned state is cleaned up.
  await Effect.runPromise(
    cleanupScratchOwnedState({ plan: scratch, provider, keepVolumes: false }).pipe(
      Effect.provideService(StateStore, stateStore.service),
      Effect.provideService(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({ select: () => Effect.succeed(provider) }),
      ),
    ),
  );

  // Then only the source app's members remain, and the shared cache volume was never inspected.
  const remaining = await Effect.runPromise(store.load(sourceRoot));
  expect(remaining?.appIds).toEqual([source.id]);
  expect(new Set(remaining?.resources.map((resource) => resource.appId))).toEqual(new Set([source.id]));
  expect(requests.some((request) => request.includes("lando-cache-composer"))).toBe(false);
});
