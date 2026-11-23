import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  planAppIdentity,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { DateTime, Effect } from "effect";
import { adoptLegacyDataRoot } from "../src/data-root-adoption.ts";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";

const volume = { name: "demo-data", scope: "app", kind: "data" } as const;
const previous: AppPlan = {
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: AbsolutePath.make("/apps/demo"),
  provider: ProviderId.make("docker"),
  services: {},
  stores: [volume],
  routes: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};
const plan = {
  ...previous,
  identity: { ...planAppIdentity(previous), dataRoot: AbsolutePath.make("/roots/local") },
};

const runAdoption = ({
  witness,
  peer,
  prior,
  retry,
}: {
  readonly witness?: string;
  readonly peer?: boolean;
  readonly prior: boolean;
  readonly retry?: boolean;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = makeResourceOwnershipStore(
        plan.provider,
        makePluginStateStore(makeTestStateStore().service, plan.identity.dataRoot, {
          enforce: async () => undefined,
          verify: async () => undefined,
        }),
      );
      const adoption = adoptLegacyDataRoot(plan, prior ? previous : undefined, {
        store,
        request: ({ path }) =>
          Effect.succeed(
            path === `/volumes/${volume.name}`
              ? {
                  status: 200,
                  body: JSON.stringify({
                    Name: volume.name,
                    Labels: {
                      ...volumeOwnershipLabels(previous, volume),
                      "dev.lando.app": previous.id,
                      "dev.lando.scope": "app",
                      "dev.lando.store": volume.name,
                      "dev.lando.volume-instance": "generation-1",
                      ...(peer ? { [LANDO_DATA_ROOT_LABEL]: "/roots/peer" } : {}),
                    },
                  }),
                }
              : { status: 404, body: "" },
          ),
        volumeWitness: () => Effect.succeed(witness),
      });
      yield* store.prepare(plan, prior ? previous : undefined);
      yield* adoption;
      if (retry) {
        yield* store.prepare(plan, prior ? previous : undefined);
        yield* adoption;
      }
      const summary = yield* store.summary(plan.root);
      return summary?.members?.filter((member) => member.dataRoot !== undefined);
    }),
  );

test("receipts retain the inspected generation and data root", async () => {
  expect(await runAdoption({ prior: true, witness: "generation-1" })).toEqual([
    {
      kind: "volume",
      nativeName: "demo-data",
      appId: previous.id,
      dataRoot: plan.identity.dataRoot,
      volumeInstance: "generation-1",
    },
  ]);
});

test.each([
  ["the stored witness names another generation", { prior: true, witness: "replaced" }],
  ["a peer data root is labeled", { prior: true, witness: "generation-1", peer: true }],
  ["only intent is written", { prior: false }],
  ["a failed apply left intent behind for a retry", { prior: false, retry: true }],
] as const)("does not write an adoption receipt when %s", async (_description, input) => {
  expect(await runAdoption(input)).toEqual([]);
});

test("global volume cleanup removes a receipted legacy volume but leaves an unverified one", async () => {
  const stores = ["old-data", "unverified-data"].map((name) => ({
    name,
    scope: "global" as const,
    kind: "data" as const,
  }));
  const legacy = { ...previous, id: AppId.make("global"), stores };
  const scoped = { ...legacy, identity: plan.identity };
  const state = makeTestStateStore();
  const store = makeResourceOwnershipStore(
    legacy.provider,
    makePluginStateStore(state.service, plan.identity.dataRoot, {
      enforce: async () => undefined,
      verify: async () => undefined,
    }),
  );
  const volumes = new Map(
    stores.map((entry) => [
      entry.name,
      {
        ...volumeOwnershipLabels(legacy, entry),
        "dev.lando.app": legacy.id,
        "dev.lando.scope": entry.scope,
        "dev.lando.store": entry.name,
        "dev.lando.volume-instance": "generation-1",
      },
    ]),
  );
  const request: NonNullable<EngineHttpApi["request"]> = ({ method, path }) =>
    Effect.sync(() => {
      const name = path.slice("/volumes/".length);
      const labels = volumes.get(name);
      if (!path.startsWith("/volumes/") || labels === undefined) return { status: 404, body: "" };
      if (method === "DELETE") {
        volumes.delete(name);
        return { status: 204, body: "" };
      }
      return { status: 200, body: JSON.stringify({ Name: name, Labels: labels }) };
    });
  const cleanup = makeOwnedResourcesCleanup({
    ctx: { providerId: legacy.provider, remediation: "Retry", env: {} },
    store,
    api: { request },
    userDataRoot: plan.identity.dataRoot,
    endpointNamespace: "fixture",
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* adoptLegacyDataRoot(scoped, legacy, {
        store,
        request,
        volumeWitness: (name) => Effect.succeed(name === "old-data" ? "generation-1" : "replaced"),
      });
      return yield* cleanup(legacy.root, { volumes: true });
    }).pipe(Effect.provide(state.layer)),
  );

  expect(result.volumesRemoved).toEqual({ data: 1, cache: 0 });
  expect([...volumes.keys()]).toEqual(["unverified-data"]);
});
