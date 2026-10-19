import { expect, test } from "bun:test";
import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { makeRuntimeProvider, persistAppliedPlan } from "@lando/provider-docker";
import { Effect } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

const replacements: readonly Readonly<Record<string, string>>[] = [
  {},
  { "dev.lando.app": "foreign", "dev.lando.app-root": "/foreign", "dev.lando.service": "web" },
];
for (const labels of replacements) {
  test(`builtin destroy refuses replacement despite an applied plan and ownership inventory ${JSON.stringify(labels)}`, async () => {
    await withInventory(async ({ plan, state, store, root }) => {
      // Given
      const applied = webFor(plan);
      await Effect.runPromise(store.prepare(applied));
      await Effect.runPromise(persistAppliedPlan(state, applied));
      const calls: EngineHttpRequest[] = [];
      let observed: {
        readonly Id: string;
        readonly Config: { readonly Labels: Readonly<Record<string, string>> };
      } = {
        Id: "owned-before",
        Config: {
          Labels: {
            "dev.lando.app": plan.id,
            "dev.lando.app-root": root,
            "dev.lando.service": "web",
          },
        },
      };
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          appliedPlanState: state,
          dockerApi: {
            info: Effect.succeed({}),
            request: (request) =>
              Effect.sync((): EngineHttpResponse => {
                calls.push(request);
                if (request.method !== "GET") return { status: 204, body: "" };
                return request.path === "/containers/lando-owned-web/json"
                  ? { status: 200, body: JSON.stringify(observed) }
                  : { status: 404, body: "" };
              }),
          },
        }),
      );
      observed = { Id: "foreign-replacement", Config: { Labels: labels } };
      // When
      const result = await Effect.runPromise(
        provider.destroy({ app: plan.id }, { volumes: false }).pipe(Effect.result),
      );
      // Then
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
      expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    });
  });
}

for (const name of ["shared-membership", "lando_bridge_network"]) {
  test(`ownership inventory cannot claim shared network ${name} through a private hint`, async () => {
    await withInventory(async ({ store, plan, root, calls, cleanup }) => {
      // Given
      const disguised = {
        ...plan,
        networking: {
          perAppBridge: { name, driver: "bridge" },
          sharedNetworkMembership: { name: "shared-membership", aliases: {} },
        },
      };
      // When
      await Effect.runPromise(store.prepare(disguised));
      const result = await Effect.runPromise(cleanup(root, { volumes: false }));
      // Then
      expect(result.networksRemoved).toBe(0);
      expect(calls).toEqual([]);
      expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
    });
  });
}
