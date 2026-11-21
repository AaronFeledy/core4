import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Deferred, Effect, Fiber } from "effect";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpResponse } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { podmanVolumeCreationLabels } from "../src/podman/bring-up.ts";
import { networkPlan } from "./authored-network-fixture.ts";

const stores: AppPlan["stores"] = [
  { name: "app-data", kind: "data", scope: "app" },
  { name: "cache-store", kind: "cache", scope: "app" },
  { name: "global-data", kind: "data", scope: "global" },
];
const plan: AppPlan = { ...networkPlan, stores };

interface Recorded {
  readonly requests: ReadonlyArray<string>;
}

const apiFor = (options: {
  readonly labels: boolean;
  readonly extra?: AppPlan["stores"];
}): Recorded & {
  readonly api: {
    readonly request: (request: { method: string; path: string }) => Effect.Effect<EngineHttpResponse>;
  };
} => {
  const requests: string[] = [];
  const volumes = new Map(
    (options.labels ? [...stores, ...(options.extra ?? [])] : []).map((store) => [
      store.name,
      podmanVolumeCreationLabels(plan, store),
    ]),
  );
  return {
    requests,
    api: {
      request: (request) =>
        Effect.sync((): EngineHttpResponse => {
          requests.push(`${request.method} ${request.path}`);
          if (request.method === "GET" && request.path.startsWith("/containers/json?"))
            return { status: 200, body: "[]" };
          if (request.path === "/volumes")
            return {
              status: 200,
              body: JSON.stringify({ Volumes: [...volumes].map(([Name, Labels]) => ({ Name, Labels })) }),
            };
          if (request.path.startsWith("/volumes/")) {
            const name = decodeURIComponent(request.path.slice("/volumes/".length));
            if (request.method !== "GET") return { status: volumes.delete(name) ? 204 : 404, body: "" };
            const labels = volumes.get(name);
            return labels === undefined
              ? { status: 404, body: "{}" }
              : {
                  status: 200,
                  body: JSON.stringify({
                    Name: name,
                    Labels: labels,
                  }),
                };
          }
          return { status: 404, body: "{}" };
        }),
    },
  };
};

test("bring-down reports removed named volumes by storage class, never by option intent", async () => {
  const recorded = apiFor({ labels: true });
  const result = await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      dialect: dockerLifecycleDialect,
      volumes: true,
      purgeCaches: true,
      api: recorded.api,
      endpointNamespace: "test-daemon",
    }).pipe(Effect.provide(makeTestStateStore().layer)),
  );

  expect(result.volumesRemoved).toEqual({ data: 1, cache: 1 });
  expect(recorded.requests).toContain("DELETE /volumes/app-data");
  expect(recorded.requests).toContain("DELETE /volumes/cache-store");
  expect(recorded.requests).not.toContain("DELETE /volumes/global-data");
});

test("bring-down reports a class with nothing present as zero even when its flag was set", async () => {
  const recorded = apiFor({ labels: false });
  const result = await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      dialect: dockerLifecycleDialect,
      volumes: true,
      api: recorded.api,
    }),
  );

  expect(result.volumesRemoved).toEqual({ data: 0, cache: 0 });
  expect(recorded.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
});

test("selector cleanup removes unplanned app data but not an unplanned shared cache (#2550)", async () => {
  const recorded = apiFor({
    labels: true,
    extra: [
      { name: "old-data", scope: "app", kind: "data" },
      { name: "old-cache", scope: "global", kind: "cache" },
    ],
  });
  const result = await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      dialect: libpodLifecycleDialect,
      volumes: true,
      purgeCaches: true,
      api: recorded.api,
      endpointNamespace: "test-daemon",
    }).pipe(Effect.provide(makeTestStateStore().layer)),
  );

  expect(result.volumesRemoved).toEqual({ data: 2, cache: 1 });
  expect(recorded.requests).toContain("DELETE /volumes/old-data");
  expect(recorded.requests).not.toContain("DELETE /volumes/old-cache");
});

test.each([false, true])(
  "a different app can purge a planned global cache unless a container holds it (held=%s)",
  async (held) => {
    const store = { name: "lando-cache-composer", scope: "global", kind: "cache" } as const;
    const creator = { ...plan, stores: [store] };
    const consumer = { ...creator, id: AppId.make("consumer"), root: AbsolutePath.make("/other/app") };
    let retained = true;
    const labels = podmanVolumeCreationLabels(creator, store);
    const result = await Effect.runPromise(
      bringDown(consumer, {
        ctx: { providerId: consumer.provider, remediation: "Retry.", env: {} },
        dialect: dockerLifecycleDialect,
        endpointNamespace: "test-daemon",
        purgeCaches: true,
        api: {
          request: ({ method, path }) =>
            Effect.sync(() => {
              if (path === "/volumes")
                return {
                  status: 200,
                  body: JSON.stringify({ Volumes: [{ Name: store.name, Labels: labels }] }),
                };
              if (path.startsWith("/containers/json?")) return { status: 200, body: "[]" };
              if (path === `/volumes/${store.name}` && retained) {
                if (method === "DELETE") {
                  if (held) return { status: 409, body: '{"message":"volume is in use"}' };
                  retained = false;
                  return { status: 204, body: "" };
                }
                return { status: 200, body: JSON.stringify({ Name: store.name, Labels: labels }) };
              }
              return { status: 404, body: "{}" };
            }),
        },
      }).pipe(Effect.provide(makeTestStateStore().layer)),
    );
    expect(result.volumesRemoved.cache).toBe(held ? 0 : 1);
    expect(retained).toBe(held);
    expect(result.skipped).toEqual(
      held ? [{ appId: consumer.id, resource: store.name, reason: "in use" }] : undefined,
    );
  },
);

test("a late volume and a same-name replacement survive the locked snapshot", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const enumerated = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const store = { name: "old-data", scope: "app", kind: "data" } as const;
      const late = { ...store, name: "late-data" };
      const volumes = new Map([[store.name as string, podmanVolumeCreationLabels(plan, store)]]);
      const fiber = yield* bringDown(
        { ...plan, stores: [] },
        {
          ctx: { providerId: plan.provider, remediation: "Retry.", env: {} },
          endpointNamespace: "test-daemon",
          volumes: true,
          api: {
            request: ({ method, path }) =>
              Effect.gen(function* () {
                if (path === "/volumes")
                  return {
                    status: 200,
                    body: JSON.stringify({
                      Volumes: [...volumes].map(([Name, Labels]) => ({ Name, Labels })),
                    }),
                  };
                if (path.startsWith("/containers/json?")) {
                  yield* Deferred.succeed(enumerated, undefined);
                  yield* Deferred.await(resume);
                  return { status: 200, body: "[]" };
                }
                const name = path.slice("/volumes/".length);
                const labels = path.startsWith("/volumes/") ? volumes.get(name) : undefined;
                if (labels === undefined) return { status: 404, body: "{}" };
                if (method === "DELETE") {
                  volumes.delete(name);
                  return { status: 204, body: "" };
                }
                return { status: 200, body: JSON.stringify({ Name: name, Labels: labels }) };
              }),
          },
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(enumerated);
      volumes.set(store.name, podmanVolumeCreationLabels(plan, store));
      volumes.set(late.name, podmanVolumeCreationLabels(plan, late));
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.volumesRemoved.data).toBe(0);
      expect([...volumes.keys()]).toEqual([store.name, late.name]);
    }).pipe(Effect.provide(makeTestStateStore().layer)),
  );
});
