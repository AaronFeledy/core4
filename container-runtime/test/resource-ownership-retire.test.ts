import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { DateTime, Effect } from "effect";
import { makeResourceOwnershipStore } from "../src/resource-ownership.ts";

const root = AbsolutePath.make("/apps/source");
const providerId = ProviderId.make("test");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
  source: "test",
  runtime: 4 as const,
};

const planFor = (id: string, stores: AppPlan["stores"] = []): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  provider: providerId,
  services: {
    [ServiceName.make("web")]: {
      name: ServiceName.make("web"),
      type: "compose",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "alpine:3.20" },
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
  stores,
  routes: [],
  fileSync: [],
  metadata,
  extensions: {},
});

test("retiring a mixed inventory keeps the source member and deletes the file on last removal", async () => {
  const store = makeResourceOwnershipStore(
    "test",
    makePluginStateStore(makeTestStateStore().service, AbsolutePath.make("/data"), {
      enforce: async () => undefined,
      verify: async () => undefined,
    }),
  );
  const source = planFor("source-app");
  const scratch = planFor("scratch-cwd-111111", [{ name: "data", scope: "app", kind: "data" }]);
  await Effect.runPromise(store.prepare(source));
  await Effect.runPromise(store.prepare(scratch, source));
  const mixed = await Effect.runPromise(store.load(root));
  const scratchMembers = mixed?.resources.filter((item) => item.appId === scratch.id) ?? [];
  expect(scratchMembers.length).toBeGreaterThan(0);
  expect(mixed?.resources.some((item) => item.appId === source.id)).toBe(true);
  for (const resource of scratchMembers) await Effect.runPromise(store.retire(root, resource));
  const afterScratch = await Effect.runPromise(store.load(root));
  expect(afterScratch?.resources.some((item) => item.appId === scratch.id)).toBe(false);
  expect(afterScratch?.resources.some((item) => item.appId === source.id)).toBe(true);
  for (const resource of afterScratch?.resources ?? []) await Effect.runPromise(store.retire(root, resource));
  expect(await Effect.runPromise(store.load(root))).toBeUndefined();
});

test("retiring the last member keeps a checked adoption batch, and a retire after removal is a no-op", async () => {
  const store = makeResourceOwnershipStore(
    "test",
    makePluginStateStore(makeTestStateStore().service, AbsolutePath.make("/data"), {
      enforce: async () => undefined,
      verify: async () => undefined,
    }),
  );
  const scratch = planFor("scratch-cwd-222222", [{ name: "data", scope: "app", kind: "data" }]);
  await Effect.runPromise(store.prepare(scratch));
  // An empty batch records that this data root's legacy adoption was already checked.
  await Effect.runPromise(
    store.recordAdoption(
      root,
      { dataRoot: AbsolutePath.make("/data"), previousAppId: scratch.id, receipts: [] },
      [],
    ),
  );
  const members = (await Effect.runPromise(store.load(root)))?.resources ?? [];
  expect(members.length).toBeGreaterThan(0);
  for (const resource of members) await Effect.runPromise(store.retire(root, resource));
  const retained = await Effect.runPromise(store.load(root));
  expect(retained?.resources).toEqual([]);
  expect(retained?.adoptions).toEqual([
    { dataRoot: AbsolutePath.make("/data"), previousAppId: scratch.id, receipts: [] },
  ]);

  const other = AbsolutePath.make("/apps/other");
  const [member] = members;
  if (member === undefined) throw new Error("expected an inventory member");
  // A concurrent cleanup already removed this root's inventory; retiring again changes nothing.
  await Effect.runPromise(store.retire(other, { ...member, appRoot: other }));
  expect(await Effect.runPromise(store.load(other))).toBeUndefined();
});
