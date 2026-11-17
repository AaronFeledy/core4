import { expect, test } from "bun:test";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
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
  readonly pruned?: boolean;
}): Recorded & {
  readonly api: {
    readonly request: (request: { method: string; path: string }) => Effect.Effect<EngineHttpResponse>;
  };
} => {
  const requests: string[] = [];
  return {
    requests,
    api: {
      request: (request) =>
        Effect.sync((): EngineHttpResponse => {
          requests.push(`${request.method} ${request.path}`);
          if (request.method === "GET" && request.path.startsWith("/containers/json?"))
            return { status: 200, body: "[]" };
          if (request.path.startsWith("/libpod/volumes/prune"))
            return {
              status: 200,
              body: JSON.stringify(options.pruned === true ? [{ Id: "pruned" }] : []),
            };
          if (request.path.startsWith("/volumes/")) {
            const name = decodeURIComponent(request.path.slice("/volumes/".length));
            if (request.method !== "GET") return { status: 204, body: "" };
            const store = options.labels ? stores.find((candidate) => candidate.name === name) : undefined;
            return store === undefined
              ? { status: 404, body: "{}" }
              : {
                  status: 200,
                  body: JSON.stringify({
                    Name: name,
                    Labels: podmanVolumeCreationLabels(plan, store),
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
    }),
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

test("bring-down counts volumes its own selector prune removed", async () => {
  const recorded = apiFor({ labels: false, pruned: true });
  const result = await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      dialect: libpodLifecycleDialect,
      volumes: true,
      purgeCaches: true,
      api: recorded.api,
    }),
  );

  expect(result.volumesRemoved).toEqual({ data: 1, cache: 1 });
  expect(
    recorded.requests.filter((request) => request.startsWith("POST /libpod/volumes/prune")),
  ).toHaveLength(2);
});
