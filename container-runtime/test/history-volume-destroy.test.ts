import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  HISTORY_MOUNT_TARGET,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";

import { dockerLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";

const historyStore = "lando-histapp-history";
const historyPlan = {
  id: AppId.make("histapp"),
  name: "histapp",
  slug: "histapp",
  root: AbsolutePath.make("/owner"),
  provider: ProviderId.make("docker"),
  identity: { appRoot: AbsolutePath.make("/owner"), ownerKey: "owner" },
  services: {
    [ServiceName.make("web")]: {
      name: ServiceName.make("web"),
      type: "php:8.3",
      provider: ProviderId.make("docker"),
      primary: true,
      artifact: { kind: "ref" as const, ref: "php:8.3-apache" },
      environment: {},
      mounts: [],
      storage: [{ store: historyStore, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
        source: "test",
        runtime: 4 as const,
      },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [{ name: historyStore, scope: "app" as const, kind: "data" as const }],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
    source: "test",
    runtime: 4 as const,
  },
  extensions: {},
} as AppPlan;

const historyVolumePath = `/volumes/${encodeURIComponent(historyStore)}`;
const historyStoreEntry = historyPlan.stores.find((store) => store.name === historyStore) ?? {
  name: historyStore,
  scope: "app" as const,
  kind: "data" as const,
};
const historyLabels = volumeOwnershipLabels(historyPlan, historyStoreEntry);

const recordingApi = (
  present = false,
): { readonly api: EngineHttpApi; readonly requests: EngineHttpRequest[] } => {
  const requests: EngineHttpRequest[] = [];
  return {
    requests,
    api: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          if (present && request.method === "GET" && request.path === historyVolumePath) {
            return {
              status: 200,
              body: JSON.stringify({ Name: historyStore, Labels: historyLabels }),
            };
          }
          if (present && request.method === "DELETE" && request.path === historyVolumePath) {
            return { status: 204, body: "" };
          }
          return { status: 404, body: "{}" };
        }),
    },
  };
};

const historyVolumeRequests = (requests: ReadonlyArray<EngineHttpRequest>) =>
  requests.filter((request) => request.path === historyVolumePath);

test("plain destroy keeps the app-scoped history volume", async () => {
  const { api, requests } = recordingApi(true);
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
    }),
  );
  expect(historyVolumeRequests(requests)).toEqual([]);
});

test("destroy --volumes issues DELETE for the history volume", async () => {
  const { api, requests } = recordingApi(true);
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
      volumes: true,
    }),
  );
  expect(historyVolumeRequests(requests).some((request) => request.method === "GET")).toBe(true);
  expect(historyVolumeRequests(requests).some((request) => request.method === "DELETE")).toBe(true);
});

test("destroy --purge issues DELETE for the history volume", async () => {
  const { api, requests } = recordingApi(true);
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
      volumes: true,
    }),
  );
  expect(historyVolumeRequests(requests).some((request) => request.method === "DELETE")).toBe(true);
});

test("destroy --purge-caches leaves the history data volume", async () => {
  const { api, requests } = recordingApi(true);
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
      purgeCaches: true,
    }),
  );
  expect(historyVolumeRequests(requests)).toEqual([]);
});
