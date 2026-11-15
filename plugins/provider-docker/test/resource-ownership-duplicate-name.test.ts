import { expect, test } from "bun:test";
import { join } from "node:path";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { loadAppliedPlan, makeRuntimeProvider, persistAppliedPlan } from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, appIdentityKey } from "@lando/sdk/schema";
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

test("a stopped app with no live resources still reserves its name without authorizing mutation", async () => {
  await withInventory(async ({ plan, root, state, store }) => {
    // Given: stop removed A's native resources but retained its applied plan.
    const rootA = AbsolutePath.make(join(root, "dup-a"));
    const rootB = AbsolutePath.make(join(root, "dup-b"));
    const appA = appAt(plan, rootA);
    await Effect.runPromise(persistAppliedPlan(state, appA));
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
              return { status: 404, body: "" };
            }),
        },
      }),
    );

    // When: B tries to apply the same app id from another root.
    const result = await Effect.runPromise(
      Effect.scoped(provider.apply(appAt(plan, rootB), { reconcile: false })).pipe(Effect.result),
    );

    // Then: the typed reservation refusal preserves both state and native resources.
    if (!Result.isFailure(result)) throw new Error("Expected the reserved name to be refused");
    expect(result.failure).toBeInstanceOf(ProviderUnavailableError);
    expect(result.failure).toMatchObject({
      operation: "resource-ownership",
      details: { root: rootA, app: appA.id, name: appA.name, reason: "name-reserved" },
    });
    expect(result.failure.message).toContain(rootA);
    expect(result.failure.message).toContain("Stopping");
    expect(result.failure.remediation).toMatch(/Change.*name:.*\.lando\.yml.*destroy.*other/iu);
    expect(mutations).toEqual([]);
    expect(await Effect.runPromise(store.summary(rootB))).toBeUndefined();
    expect(await Effect.runPromise(loadAppliedPlan(state, appA.id))).toEqual(appA);
  });
});

test("same-root previous plan remains eligible for an ownership update", async () => {
  await withInventory(async ({ plan, root, store }) => {
    const previous = webFor(plan);

    await Effect.runPromise(store.prepare(previous, previous));

    expect((await Effect.runPromise(store.load(root)))?.appIds).toEqual([plan.id]);
  });
});

test.each(["provider", "owner-key", "owner-root", "app-id"] as const)(
  "a foreign previous plan with mismatched %s retains the generic integrity refusal",
  async (damage) => {
    await withInventory(async ({ plan, root, store }) => {
      const foreignRoot = AbsolutePath.make(join(root, "foreign"));
      const valid = appAt(plan, foreignRoot);
      const previous: AppPlan = {
        ...valid,
        provider: damage === "provider" ? ProviderId.make("podman") : valid.provider,
        id: damage === "app-id" ? AppId.make("different") : valid.id,
        identity: {
          appRoot: damage === "owner-root" ? root : foreignRoot,
          ownerKey: damage === "owner-key" ? "invalid-owner" : appIdentityKey("owner", foreignRoot),
        },
      };

      const result = await Effect.runPromise(store.prepare(appAt(plan, root), previous).pipe(Effect.result));

      if (!Result.isFailure(result)) throw new Error("Expected invalid previous ownership to be refused");
      expect(result.failure).toMatchObject({
        _tag: "ProviderUnavailableError",
        operation: "resource-ownership",
        message: "Resource ownership inventory could not be verified or persisted.",
      });
      expect(result.failure.details).toBeUndefined();
      expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
    });
  },
);

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
