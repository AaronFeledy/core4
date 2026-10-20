import { expect, test } from "bun:test";
import type { EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { loadAppliedPlan, makeRuntimeProvider } from "@lando/provider-docker";
import { ServiceName, landoAppNetworkName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

const CreateBodyLabels = Schema.Struct({
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const NetworkCreateBody = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

test("failed apply leaves durable ownership hints for verified later cleanup without rollback", async () => {
  await withInventory(async ({ plan, root, state, store }) => {
    // Given
    const desired = webFor(plan);
    const networks = new Map<
      string,
      { readonly Id: string; readonly Labels: Readonly<Record<string, string>> }
    >();
    let cleanupEnabled = false;
    let deleteAttempts = 0;
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync((): EngineHttpResponse => {
              if (request.path === "/networks/create") {
                const created = Schema.decodeUnknownSync(NetworkCreateBody)(request.body);
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
                  deleteAttempts += 1;
                  if (!cleanupEnabled) {
                    return { status: 500, body: "cleanup not enabled yet" };
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
    // Retention: apply does not compensate/teardown on failure.
    expect(deleteAttempts).toBe(0);
    expect(networks.has(landoAppNetworkName(desired))).toBe(true);
    expect(await Effect.runPromise(loadAppliedPlan(state, desired.id))).toBeUndefined();
    expect(await Effect.runPromise(store.summary(root))).toBeDefined();
    const cleanup = provider.cleanupOwnedResources;
    if (cleanup === undefined) throw new TypeError("built-in cleanup port is missing");
    cleanupEnabled = true;
    // When: later ownership-inventory cleanup removes retained resources.
    const removed = await Effect.runPromise(cleanup(root, { volumes: false }));
    // Then
    expect(removed).toEqual({ servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 });
    expect(networks.has(landoAppNetworkName(desired))).toBe(false);
    expect(networks.size).toBe(1);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});

test("destroy of a partial apply is a no-op and ownership inventory removes retained container and private network", async () => {
  await withInventory(async ({ plan, root, state, store }) => {
    // Given a failed apply that recorded ownership hints but never an applied plan.
    const desired = webFor(plan);
    const privateNetwork = landoAppNetworkName(desired);
    const containerName = "lando-owned-web";
    const networks = new Map<
      string,
      { readonly Id: string; readonly Labels: Readonly<Record<string, string>> }
    >();
    const containers = new Map<
      string,
      { readonly Id: string; readonly Labels: Readonly<Record<string, string>> }
    >();
    let createdSeq = 0;
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync((): EngineHttpResponse => {
              if (request.path === "/networks/create") {
                const created = Schema.decodeUnknownSync(NetworkCreateBody)(request.body);
                networks.set(created.Name, { Id: `network-${networks.size}`, Labels: created.Labels ?? {} });
                return { status: 201, body: "{}" };
              }
              if (request.path.startsWith("/networks/")) {
                const name = decodeURIComponent(request.path.slice("/networks/".length));
                if (request.method === "GET") {
                  const observed = networks.get(name) ?? [...networks.values()].find((n) => n.Id === name);
                  return observed === undefined
                    ? { status: 404, body: "" }
                    : { status: 200, body: JSON.stringify(observed) };
                }
                if (request.method === "DELETE") {
                  const found = [...networks.entries()].find(
                    ([n, network]) => n === name || network.Id === name,
                  );
                  if (found === undefined) return { status: 404, body: "" };
                  networks.delete(found[0]);
                  return { status: 204, body: "" };
                }
              }
              if (request.path.startsWith("/images/")) return { status: 200, body: "{}" };
              if (request.path.startsWith("/containers/create")) {
                const name = new URL(`http://x${request.path}`).searchParams.get("name") ?? "web";
                const decoded = Schema.decodeUnknownSync(CreateBodyLabels)(request.body);
                createdSeq += 1;
                containers.set(name, {
                  Id: `id-${name}-created-${createdSeq}`,
                  Labels: decoded.Labels ?? {},
                });
                return { status: 201, body: "{}" };
              }
              if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
                const name = request.path.slice("/containers/".length, -"/json".length);
                const observed =
                  containers.get(name) ?? [...containers.entries()].find(([, c]) => c.Id === name)?.[1];
                return observed === undefined
                  ? { status: 404, body: "" }
                  : {
                      status: 200,
                      body: JSON.stringify({
                        Id: observed.Id,
                        Config: { Labels: observed.Labels },
                        State: { Running: false },
                      }),
                    };
              }
              if (request.path.endsWith("/start")) return { status: 500, body: "start failed" };
              if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
                const ref = request.path.slice("/containers/".length).split("?")[0] ?? "";
                const found = [...containers.entries()].find(([n, c]) => n === ref || c.Id === ref);
                if (found === undefined) return { status: 404, body: "" };
                containers.delete(found[0]);
                return { status: 204, body: "" };
              }
              if (request.path.endsWith("/stop")) return { status: 204, body: "" };
              return { status: 404, body: "" };
            }),
        },
      }),
    );
    const failed = await Effect.runPromise(
      Effect.scoped(provider.apply(desired, { reconcile: false })).pipe(Effect.result),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(await Effect.runPromise(loadAppliedPlan(state, desired.id))).toBeUndefined();
    expect(await Effect.runPromise(store.summary(root))).toBeDefined();
    // Explicit retained container + private network before cleanup.
    expect(containers.has(containerName)).toBe(true);
    expect(networks.has(privateNetwork)).toBe(true);

    // When: destroy without applied plan is a no-op for planful teardown.
    const destroyed = await Effect.runPromise(provider.destroy({ app: desired.id }, { volumes: false }));
    expect(destroyed).toMatchObject({ kind: "no-op", reason: "no-applied-plan" });
    expect(containers.has(containerName)).toBe(true);
    expect(networks.has(privateNetwork)).toBe(true);

    // Inventory cleanup removes both retained resources.
    const cleanup = provider.cleanupOwnedResources;
    if (cleanup === undefined) throw new TypeError("built-in cleanup port is missing");
    const removed = await Effect.runPromise(cleanup(root, { volumes: false }));

    // Then
    expect(removed).toEqual({
      servicesRemoved: [ServiceName.make("web")],
      networksRemoved: 1,
      volumesRemoved: 0,
    });
    expect(containers.has(containerName)).toBe(false);
    expect(networks.has(privateNetwork)).toBe(false);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});

test("unknown ownership on retry fails closed without mutating foreign resources", async () => {
  await withInventory(async ({ plan, state }) => {
    // Given a foreign container already occupying the planned name.
    const desired = webFor(plan);
    const name = "lando-owned-web";
    const calls: string[] = [];
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: state,
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync((): EngineHttpResponse => {
              calls.push(`${request.method} ${request.path}`);
              if (request.path.startsWith("/networks/")) {
                if (request.method === "GET") return { status: 404, body: "" };
                if (request.path === "/networks/create") return { status: 201, body: "{}" };
              }
              if (request.path === `/containers/${name}/json`) {
                return {
                  status: 200,
                  body: JSON.stringify({
                    Id: "foreign-id",
                    Config: { Labels: { "dev.lando.app": "foreign", "dev.lando.app-root": "/foreign" } },
                    State: { Running: true },
                  }),
                };
              }
              if (request.path.startsWith("/images/")) return { status: 200, body: "{}" };
              return { status: 404, body: "" };
            }),
        },
      }),
    );

    // When: retry twice with reconcile false on the same planned name.
    const first = await Effect.runPromise(
      Effect.scoped(provider.apply(desired, { reconcile: false })).pipe(Effect.result),
    );
    const callsAfterFirst = calls.length;
    const second = await Effect.runPromise(
      Effect.scoped(provider.apply(desired, { reconcile: false })).pipe(Effect.result),
    );

    // Then: ownership verification refuses mutation of the foreign object both times.
    expect(Result.isFailure(first)).toBe(true);
    expect(Result.isFailure(second)).toBe(true);
    if (Result.isFailure(first)) {
      expect(first.failure).toMatchObject({
        _tag: "ProviderUnavailableError",
        operation: "resource-ownership",
      });
    }
    if (Result.isFailure(second)) {
      expect(second.failure).toMatchObject({
        _tag: "ProviderUnavailableError",
        operation: "resource-ownership",
      });
    }
    expect(calls.filter((call) => call.startsWith("DELETE "))).toEqual([]);
    expect(calls.filter((call) => call.includes("/stop"))).toEqual([]);
    expect(calls.filter((call) => call.includes("/start"))).toEqual([]);
    expect(calls.filter((call) => call.includes("/containers/create"))).toEqual([]);
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
    expect(await Effect.runPromise(loadAppliedPlan(state, desired.id))).toBeUndefined();
  });
});
