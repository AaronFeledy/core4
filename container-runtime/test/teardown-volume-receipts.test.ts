import { expect, test } from "bun:test";
import { AbsolutePath, AppId, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { makeTestStateStore } from "@lando/state-store/testing";
import { readVolumeInitialization, volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect } from "effect";
import { VOLUME_INSTANCE_LABEL } from "../src/labels.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { volumeCreationLabels } from "../src/volume-creation.ts";
import { GLOBAL_CACHE_OWNER } from "../src/volume-ownership.ts";

const root = AbsolutePath.make("/apps/receipts");
const providerId = ProviderId.make("test");
const appId = AppId.make("receipts");
const owner = { appRoot: root, providerId, appId, ownerKey: appIdentityKey("owner", root) };
const data = { name: "database", kind: "data", scope: "app" } as const;
const labels = {
  ...volumeCreationLabels({ root, provider: providerId, id: appId, extensions: {} }, data),
  [VOLUME_INSTANCE_LABEL]: "current-generation",
};

const cache = { name: "npm-cache", kind: "cache", scope: "global" } as const;

const destroyVolumes = (input: {
  readonly volumePresent: boolean;
  readonly receiptGeneration: string;
  readonly store?: typeof data | typeof cache;
  readonly corruptReceipt?: boolean;
}) =>
  Effect.gen(function* () {
    const store = input.store ?? data;
    const shared = store.scope === "global";
    const key = JSON.stringify(["endpoint:test-daemon", store.name]);
    const state = makeTestStateStore();
    yield* volumeInitialization(state.service, {
      coordinationKey: key,
      nativeName: store.name,
      generation: input.receiptGeneration,
      ownerRoot: shared ? GLOBAL_CACHE_OWNER : root,
      origin: "created",
    }).pipe(Effect.flatMap((api) => api.recordCreation));
    if (input.corruptReceipt === true)
      for (const file of state.snapshot().keys())
        if (file.includes("volume-initialization")) yield* state.writeRaw(AbsolutePath.make(file), "{");
    let present = input.volumePresent;
    const cleanup = makeOwnedResourcesCleanup({
      ctx: { providerId, remediation: "Retry cleanup.", env: {} },
      endpointNamespace: "test-daemon",
      store: {
        ...makeResourceOwnershipStore(providerId),
        load: () =>
          Effect.succeed({
            ...owner,
            appIds: [appId],
            resources: [
              {
                ...owner,
                identityDigest: store.name,
                kind: "volume",
                nativeName: store.name,
                volumeClass: store.kind,
                volumeScope: store.scope,
              },
            ],
          }),
        retire: () => Effect.void,
      },
      api: {
        request: ({ method }) =>
          Effect.sync(() => {
            if (!present) return { status: 404, body: "" };
            if (method === "GET")
              return { status: 200, body: JSON.stringify({ Name: data.name, Labels: labels }) };
            present = false;
            return { status: 204, body: "" };
          }),
      },
    });
    const result = yield* cleanup(root, { volumes: true, purgeCaches: shared }).pipe(
      Effect.provide(state.layer),
    );
    if (input.corruptReceipt === true) return { result, remaining: null };
    return { result, remaining: yield* readVolumeInitialization(state.service, key) };
  });

test.each([
  {
    name: "removes the receipt of the generation it deleted",
    volumePresent: true,
    receiptGeneration: "current-generation",
    kept: false,
  },
  {
    name: "removes the leftover receipt of a volume that is already gone",
    volumePresent: false,
    receiptGeneration: "older-generation",
    kept: false,
  },
  {
    name: "keeps the receipt of another generation",
    volumePresent: true,
    receiptGeneration: "older-generation",
    kept: true,
  },
])("volume teardown $name", async ({ volumePresent, receiptGeneration, kept }) => {
  const { remaining } = await Effect.runPromise(destroyVolumes({ volumePresent, receiptGeneration }));

  expect(remaining?.identity.generation).toBe(kept ? receiptGeneration : undefined);
});

test("volume teardown keeps its removal results when the receipt cannot be retired", async () => {
  const { result } = await Effect.runPromise(
    destroyVolumes({ volumePresent: true, receiptGeneration: "current-generation", corruptReceipt: true }),
  );

  expect(result).toMatchObject({ volumesRemoved: { data: 1 } });
});

test("an absent shared cache keeps its receipt for the apps that still share it", async () => {
  const { remaining } = await Effect.runPromise(
    destroyVolumes({ volumePresent: false, receiptGeneration: "shared-generation", store: cache }),
  );

  expect(remaining?.identity.generation).toBe("shared-generation");
});
