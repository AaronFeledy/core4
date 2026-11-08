import { expect, test } from "bun:test";
import { join } from "node:path";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { makeRuntimeProvider, persistAppliedPlan } from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, appIdentityKey } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

const appAt = (plan: AppPlan, root: AbsolutePath): AppPlan =>
  webFor({
    ...plan,
    id: AppId.make("dup"),
    slug: "dup",
    name: "dup",
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  });

test("starting a second app with a running app's name names the other app's root before any mutation", async () => {
  await withInventory(async ({ plan, root, state, store }) => {
    // Given: app A (same `name:`, other directory) is running, its applied plan stored under the shared id.
    const rootA = AbsolutePath.make(join(root, "dup-a"));
    const rootB = AbsolutePath.make(join(root, "dup-b"));
    const appA = appAt(plan, rootA);
    await Effect.runPromise(persistAppliedPlan(state, appA));
    const observed: Record<string, object> = {
      "/containers/lando-dup--web/json": {
        Id: "container-a",
        Config: {
          Labels: {
            "dev.lando.app": "dup",
            "dev.lando.app-root": rootA,
            "dev.lando.service": "web",
            "dev.lando.provider": "docker",
          },
        },
      },
      "/networks/lando-dup": {
        Id: "network-a",
        Name: "lando-dup",
        Labels: {
          "dev.lando.app": "dup",
          "dev.lando.app-root": rootA,
          "dev.lando.owner": appIdentityKey("owner", rootA),
          "dev.lando.provider": "docker",
        },
      },
    };
    const mutations: EngineHttpRequest[] = [];
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync(() => {
              if (request.method !== "GET") mutations.push(request);
              const body = observed[request.path];
              return body === undefined
                ? { status: 404, body: "" }
                : { status: 200, body: JSON.stringify(body) };
            }),
        },
      }),
    );

    // When: app B starts.
    const result = await Effect.runPromise(
      Effect.scoped(provider.apply(appAt(plan, rootB), { reconcile: false })).pipe(Effect.result),
    );

    // Then: the refusal names the conflicting container and A's root, and nothing was mutated.
    if (!Result.isFailure(result)) throw new Error("Expected the second app's start to be refused");
    expect(result.failure).toBeInstanceOf(ProviderUnavailableError);
    expect(result.failure).toMatchObject({
      operation: "resource-ownership",
      message: `Container lando-dup--web already belongs to the Lando app at ${rootA}. Two apps can't use the same name.`,
      remediation:
        "Change `name:` in this app's .lando.yml (or destroy the other app) and run `lando start` again.",
    });
    expect(mutations).toEqual([]);
    expect(await Effect.runPromise(store.summary(rootB))).toBeUndefined();
  });
});
