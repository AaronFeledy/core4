import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, VolumeIdentity } from "@lando/sdk/schema";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Result } from "effect";
import { startApp } from "../../src/operations/start.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("a retry can claim seed initialization after apply creates a volume then fails", async () => {
  const stateStore = makeTestStateStore();
  const plannedApp: AppPlan = {
    ...plan,
    identity: { appRoot: plan.root, ownerKey: "owner" },
    stores: [{ name: "data", scope: "app", kind: "data" }],
  };
  const identity: VolumeIdentity = {
    coordinationKey: "daemon/data",
    nativeName: "data",
    generation: "first-generation",
    ownerRoot: plan.root,
    origin: "created",
  };
  let created = false;
  let callbacks = 0;
  const harness = makeHarness({
    plannedApp,
    stateStore,
    locateVolume: () =>
      Effect.succeed({
        coordinationKey: identity.coordinationKey,
        nativeName: identity.nativeName,
        ...(created ? { identity } : {}),
      }),
    apply: (_plan, options) =>
      Effect.gen(function* () {
        if (!created) {
          created = true;
          if (options.onVolumeCreated !== undefined) {
            callbacks += 1;
            yield* options.onVolumeCreated(identity);
          }
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "apply",
              message: "Web container creation failed after creating the database volume.",
            }),
          );
        }
        return { changed: true, createdVolumes: [] };
      }),
  });

  const start = startApp(
    {},
    {
      plan: plannedApp,
      root: plannedApp.root,
      app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    },
  ).pipe(Effect.provide(harness.layer));
  const failed = await Effect.runPromise(Effect.result(start));
  const retried = await Effect.runPromise(start);

  expect(Result.isFailure(failed)).toBe(true);
  expect(retried.servicesStarted).toHaveLength(1);
  expect(callbacks).toBe(1);
  const initialization = await Effect.runPromise(volumeInitialization(stateStore.service, identity));
  expect((await Effect.runPromise(initialization.read))?.state._tag).toBe("fresh");
  expect(await Effect.runPromise(initialization.begin("db-seed"))).toBe(true);
});
