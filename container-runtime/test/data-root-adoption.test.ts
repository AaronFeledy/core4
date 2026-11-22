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
