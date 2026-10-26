import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

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
