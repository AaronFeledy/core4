import { expect, test } from "bun:test";
import type { EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { loadAppliedPlan, makeRuntimeProvider } from "@lando/provider-docker";
import { landoAppNetworkName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

test("failed apply and failed rollback leave durable hints for verified later cleanup", async () => {
  await withInventory(async ({ plan, root, state, store }) => {
    // Given
    const desired = webFor(plan);
    const networks = new Map<
      string,
      { readonly Id: string; readonly Labels: Readonly<Record<string, string>> }
    >();
    let cleanupEnabled = false;
    let rollbackFailures = 0;
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync((): EngineHttpResponse => {
              if (request.path === "/networks/create") {
                const created = Schema.decodeUnknownSync(
                  Schema.Struct({
                    Name: Schema.String,
                    Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
                  }),
                )(request.body);
                networks.set(created.Name, { Id: `network-${networks.size}`, Labels: created.Labels ?? {} });
                return { status: 201, body: "{}" };
              }
              if (request.path.startsWith("/networks/")) {
                const name = decodeURIComponent(request.path.slice("/networks/".length));
                if (request.method === "GET") {
                  const observed = networks.get(name);
                  return observed === undefined
                    ? { status: 404, body: "" }
                    : { status: 200, body: JSON.stringify(observed) };
                }
                if (request.method === "DELETE") {
                  if (!cleanupEnabled) {
                    rollbackFailures += 1;
                    return { status: 500, body: "rollback teardown failed" };
                  }
                  const found = [...networks.entries()].find(([, network]) => network.Id === name);
                  if (found === undefined) return { status: 404, body: "" };
                  networks.delete(found[0]);
                  return { status: 204, body: "" };
                }
              }
              if (request.path.startsWith("/images/")) return { status: 200, body: "{}" };
              if (request.path.startsWith("/containers/create"))
                return { status: 500, body: "container create failed" };
              return { status: 404, body: "" };
            }),
        },
      }),
    );
    const failed = await Effect.runPromise(
      Effect.scoped(provider.apply(desired, { reconcile: false })).pipe(Effect.result),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(rollbackFailures).toBeGreaterThan(0);
    expect(networks.has(landoAppNetworkName(desired))).toBe(true);
    expect(await Effect.runPromise(loadAppliedPlan(state, desired.id))).toBeUndefined();
    expect(await Effect.runPromise(store.summary(root))).toBeDefined();
    const cleanup = provider.cleanupOwnedResources;
    if (cleanup === undefined) throw new TypeError("built-in cleanup port is missing");
    cleanupEnabled = true;
    // When
    const removed = await Effect.runPromise(cleanup(root, { volumes: false }));
    // Then
    expect(removed).toEqual({ servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 });
    expect(networks.has(landoAppNetworkName(desired))).toBe(false);
    expect(networks.size).toBe(1);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});
