import { expect, test } from "bun:test";
import { AbsolutePath, AppId, ProviderId, ServiceName, appIdentityKey, planDataId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { makeTestStateStore } from "@lando/state-store/testing";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { DateTime, Effect } from "effect";
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
