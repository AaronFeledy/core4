import { expect, test } from "bun:test";
import { podmanVolumeCreationLabels } from "@lando/container-runtime/podman/bring-up";
import { AppId, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

test("inventory cleanup removes original data volumes after an app rename", async () => {
  await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
    const data = { name: "original-data", scope: "app", kind: "data" } as const;
    const original = webFor({ ...plan, stores: [data] });
    const renamed = {
      ...original,
      id: AppId.make("renamed"),
      slug: "renamed",
      identity: { appRoot: root, ownerKey: appIdentityKey("owner", root), dataName: "owned" },
    };
    await Effect.runPromise(store.prepare(renamed, original));
    const inventory = await Effect.runPromise(store.load(root));
    if (inventory === undefined) throw new Error("Expected prepared inventory");
    expect(inventory.appIds.toSorted()).toEqual([AppId.make("owned"), AppId.make("renamed")]);
    expect(
      inventory.resources.filter((resource) => resource.kind === "volume").map((resource) => resource.appId),
    ).toEqual([AppId.make("owned")]);
    expect(
      inventory.resources
        .filter((resource) => resource.kind === "container")
        .map((resource) => resource.appId)
        .toSorted(),
    ).toEqual([AppId.make("owned"), AppId.make("renamed")]);
    observations.set("/volumes/original-data", {
      Name: data.name,
      Labels: podmanVolumeCreationLabels(original, data),
    });

    const result = await Effect.runPromise(cleanup(root, { volumes: true, appIds: inventory.appIds }));

    expect(result.volumesRemoved).toBe(1);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/volumes/original-data",
    ]);
  });
});
