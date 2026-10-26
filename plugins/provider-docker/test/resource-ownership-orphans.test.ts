import { expect, test } from "bun:test";
import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { makeRuntimeProvider } from "@lando/provider-docker";
import { landoNetworkingPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

const NetworkBody = Schema.Struct({
  Name: Schema.String,
  Driver: Schema.String,
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const ContainerBody = Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) });

test.each([204, 403, 409])(
  "successful apply cleans orphan networks only after replacing containers (HTTP %s)",
  async (status) => {
    await withInventory(async ({ plan, state, store, root }) => {
      // Given
      const desired = webFor(plan);
      const networking = (extra: boolean) =>
        landoNetworkingPlan({
          slug: desired.slug,
          serviceNames: ["web"],
          sharedCrossAppNetwork: true,
          authoredNetworks: extra ? [{ key: "extra", external: false, members: { web: [] } }] : [],
        });
      const calls: EngineHttpRequest[] = [];
      const networks = new Map<string, object>();
      let container:
        | {
            readonly Id: string;
            readonly Config: { readonly Labels: Readonly<Record<string, string>> };
            readonly State: { readonly Running: true };
          }
        | undefined;
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          appliedPlanState: state,
          dockerApi: {
            info: Effect.succeed({}),
            request: (request) =>
              Effect.sync((): EngineHttpResponse => {
                calls.push(request);
                if (request.path === "/networks/create") {
                  const body = Schema.decodeUnknownSync(NetworkBody)(request.body);
                  networks.set(body.Name, { ...body, Id: `id-${body.Name}` });
                  return { status: 201, body: "{}" };
                }
                if (request.path.startsWith("/networks/")) {
                  if (request.method === "DELETE")
                    return { status, body: status === 204 ? "" : "network has active endpoints" };
                  if (request.path.endsWith("/connect")) return { status: 200, body: "{}" };
                  const body = networks.get(decodeURIComponent(request.path.slice("/networks/".length)));
                  return body === undefined
                    ? { status: 404, body: "" }
                    : { status: 200, body: JSON.stringify(body) };
                }
                if (request.path.startsWith("/images/")) return { status: 200, body: "{}" };
                if (request.path.startsWith("/containers/create")) {
                  const body = Schema.decodeUnknownSync(ContainerBody)(request.body);
                  container = {
                    Id: "container-id",
                    Config: { Labels: body.Labels },
                    State: { Running: true },
                  };
                  return { status: 201, body: "{}" };
                }
                if (request.method === "DELETE") {
                  container = undefined;
                  return { status: 204, body: "" };
                }
                if (request.path.endsWith("/json"))
                  return container === undefined
                    ? { status: 404, body: "" }
                    : { status: 200, body: JSON.stringify(container) };
                return { status: 204, body: "" };
              }),
          },
        }),
      );
      await Effect.runPromise(
        Effect.scoped(provider.apply({ ...desired, networking: networking(true) }, { reconcile: false })),
      );
      calls.length = 0;
      // When
      await Effect.runPromise(
        Effect.scoped(provider.apply({ ...desired, networking: networking(false) }, { reconcile: false })),
      );
      // Then
      const removed = calls.findIndex(
        ({ method, path }) => method === "DELETE" && path === "/networks/id-lando-owned_extra",
      );
      const started = calls.findIndex(({ path }) => path.endsWith("/start"));
      expect(started).toBeGreaterThan(-1);
      expect(removed).toBeGreaterThan(started);
      expect(
        calls.filter(({ method, path }) => method === "DELETE" && path.startsWith("/networks/")),
      ).toEqual([{ method: "DELETE", path: "/networks/id-lando-owned_extra" }]);
      const inventory = await Effect.runPromise(store.load(root));
      expect(inventory?.resources.some((resource) => resource.nativeName === "lando-owned_extra")).toBe(
        status !== 204,
      );
    });
  },
);
