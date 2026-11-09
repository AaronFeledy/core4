import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withInventory } from "./resource-ownership-support.ts";

test("rename retains old-name data ownership until a later volume teardown selects every app id", async () => {
  await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
    const old = { ...plan, stores: [{ name: "old-data", kind: "data", scope: "app" }] as const };
    const renamed = {
      ...plan,
      id: AppId.make("renamed"),
      name: "renamed",
      slug: "renamed",
      stores: [{ name: "new-data", kind: "data", scope: "app" }] as const,
    };
    await Effect.runPromise(store.prepare(old));
    await Effect.runPromise(store.prepare(renamed));
    for (const realization of [old, renamed]) {
      const volume = realization.stores[0];
      observations.set(`/volumes/${volume.name}`, {
        Name: volume.name,
        Labels: {
          "dev.lando.app": realization.id,
          "dev.lando.volume-owner": root,
          "dev.lando.volume-selector": `docker:${realization.id}:${plan.identity?.ownerKey}:data`,
          "dev.lando.scope": "app",
          "dev.lando.volume-instance": `generation-${volume.name}`,
        },
      });
    }
    await Effect.runPromise(cleanup(root, { volumes: false }));
    const retained = await Effect.runPromise(store.summary(root));
    expect(retained?.appIds).toEqual([old.id, renamed.id]);
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    const result = await Effect.runPromise(cleanup(root, { volumes: true, appIds: retained?.appIds ?? [] }));
    expect(result.volumesRemoved).toBe(2);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/volumes/old-data",
      "/volumes/new-data",
    ]);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});
