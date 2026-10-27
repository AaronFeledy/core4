import { expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { AppId, landoNetworkingPlan, planAppIdentity } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

test("bridge inventory identity keeps its historical digest without a role", async () => {
  await withInventory(async ({ store, plan, root }) => {
    // Given
    const identity = {
      kind: "network" as const,
      nativeName: "lando-owned",
      appId: plan.id,
      appRoot: root,
      ownerKey: planAppIdentity(plan).ownerKey,
      providerId: plan.provider,
    };
    // When
    await Effect.runPromise(store.prepare(plan));
    const inventory = await Effect.runPromise(store.load(root));
    // Then
    expect(inventory?.resources).toEqual([
      { ...identity, identityDigest: sha256Hex(canonicalJson(identity)) },
    ]);
  });
});

test.each([{ Labels: {} }, { Labels: null }, {}])(
  "inventory cleanup refuses unlabeled authored networks: %j",
  async (legacy) => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
      // Given
      await Effect.runPromise(
        store.prepare({
          ...plan,
          networking: landoNetworkingPlan({
            slug: plan.slug,
            serviceNames: ["web"],
            sharedCrossAppNetwork: false,
            authoredNetworks: [{ key: "extra", external: false, members: { web: [] } }],
          }),
        }),
      );
      observations.set("/networks/lando-owned_extra", {
        Id: "unlabeled",
        Name: "lando-owned_extra",
        ...legacy,
      });
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "ProviderUnavailableError",
          operation: "resource-ownership",
        });
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      expect((await Effect.runPromise(store.load(root)))?.resources).toEqual([
        expect.objectContaining({ nativeName: "lando-owned_extra", role: "authored" }),
      ]);
    });
  },
);

test.each(["previous plan", "failed attempt"])(
  "retains owned authored networks from a %s but never inventories external or shared networks",
  async (source) => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls, network }) => {
      // Given
      const previous = {
        ...plan,
        networking: landoNetworkingPlan({
          slug: plan.slug,
          serviceNames: ["web"],
          sharedCrossAppNetwork: true,
          authoredNetworks: [
            { key: "extra", external: false, members: { web: [] } },
            { key: "sibling", external: true, members: { web: [] } },
          ],
        }),
      };
      if (source === "failed attempt") await Effect.runPromise(store.prepare(previous));
      await Effect.runPromise(store.prepare(plan, source === "previous plan" ? previous : undefined));
      expect(
        (await Effect.runPromise(store.load(root)))?.resources.map((resource) => resource.nativeName),
      ).toEqual(["lando-owned", "lando-owned_extra"]);
      for (const name of ["lando-owned", "lando-owned_extra"])
        observations.set(`/networks/${name}`, { ...network(), Id: `id-${name}` });
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: false }));
      // Then
      expect(result.networksRemoved).toBe(2);
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /networks/lando-owned",
        "DELETE /networks/id-lando-owned",
        "GET /networks/lando-owned_extra",
        "DELETE /networks/id-lando-owned_extra",
      ]);
    });
  },
);

test("identity-scoped cleanup preserves a colocated scratch inventory", async () => {
  await withInventory(async ({ store, plan, root, cleanup, calls }) => {
    const scratch = { ...plan, id: AppId.make("scratch-colocated"), slug: "scratch-colocated" };
    await Effect.runPromise(store.prepare(webFor(plan)));
    await Effect.runPromise(store.prepare(webFor(scratch)));
    await Effect.runPromise(cleanup(root, { volumes: true, appIds: [plan.id] }));
    expect(calls.some((call) => call.path.includes("scratch-colocated"))).toBe(false);
    expect((await Effect.runPromise(store.summary(root)))?.appIds).toEqual([scratch.id]);
  });
});

for (const selection of [
  { volumes: false, purgeCaches: false, removed: [] },
  { volumes: true, purgeCaches: false, removed: ["data"] },
  { volumes: false, purgeCaches: true, removed: ["cache"] },
  { volumes: true, purgeCaches: true, removed: ["data", "cache"] },
]) {
  test(`verified volume cleanup respects data/cache/global policy ${JSON.stringify(selection)}`, async () => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
      // Given
      const stores = [
        { name: "data", kind: "data", scope: "app" },
        { name: "cache", kind: "cache", scope: "global" },
        { name: "shared", kind: "data", scope: "global" },
      ] as const;
      await Effect.runPromise(store.prepare({ ...plan, stores }));
      for (const volume of stores)
        observations.set(`/volumes/${volume.name}`, {
          Name: volume.name,
          Labels: {
            "dev.lando.app": plan.id,
            "dev.lando.volume-owner": root,
            "dev.lando.volume-selector": `docker:${plan.id}:${plan.identity?.ownerKey}:${volume.kind}`,
            "dev.lando.scope": volume.scope,
            "dev.lando.volume-instance": `generation-${volume.name}`,
          },
        });
      // When
      const result = await Effect.runPromise(cleanup(root, selection));
      // Then
      expect(result.volumesRemoved).toBe(selection.removed.length);
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(
        selection.removed.map((name): `/${string}` => `/volumes/${name}`),
      );
      expect(
        (await Effect.runPromise(store.load(root)))?.resources
          .filter((resource) => resource.kind === "volume")
          .map((resource) => resource.nativeName),
      ).toEqual(
        stores.filter((volume) => !selection.removed.includes(volume.name)).map((volume) => volume.name),
      );
    });
  });
}

for (const foreign of [false, true]) {
  test(`container cleanup requires fresh label proof and uses native identity (foreign=${foreign})`, async () => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
      // Given
      await Effect.runPromise(store.prepare(webFor(plan)));
      observations.set("/containers/lando-owned-web/json", {
        Id: "observed-container-id",
        Config: {
          Labels: {
            "dev.lando.app": plan.id,
            "dev.lando.app-root": foreign ? "/foreign" : root,
            "dev.lando.service": "web",
          },
        },
      });
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(foreign);
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(
        foreign ? [] : ["/containers/observed-container-id?force=true&v=true"],
      );
    });
  });
}

test("a Git-grouped app identity still verifies, re-prepares, and cleans its recorded resources", async () => {
  await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
    // Given: a worktree-style identity that carries the shared repository group key.
    const grouped = webFor({
      ...plan,
      identity: { appRoot: root, ownerKey: plan.identity?.ownerKey ?? "", repoGroupKey: "repo-group" },
    });
    await Effect.runPromise(store.prepare(grouped));
    await Effect.runPromise(store.prepare(grouped));
    observations.set("/containers/lando-owned-web/json", {
      Id: "observed-container-id",
      Config: {
        Labels: { "dev.lando.app": plan.id, "dev.lando.app-root": root, "dev.lando.service": "web" },
      },
    });
    // When
    const result = await Effect.runPromise(cleanup(root, { volumes: true }));
    // Then
    expect(result.servicesRemoved.map(String)).toEqual(["web"]);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/containers/observed-container-id?force=true&v=true",
    ]);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});
