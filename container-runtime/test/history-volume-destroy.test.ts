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

const recordingApi = (): { readonly api: EngineHttpApi; readonly requests: EngineHttpRequest[] } => {
  const requests: EngineHttpRequest[] = [];
  return {
    requests,
    api: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return { status: 404, body: "{}" };
        }),
    },
  };
};

const historyVolumeRequests = (requests: ReadonlyArray<EngineHttpRequest>) =>
  requests.filter((request) => request.path.includes(`/volumes/${encodeURIComponent(historyStore)}`));

test("plain destroy keeps the app-scoped history volume", async () => {
  const { api, requests } = recordingApi();
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
    }),
  );
  expect(historyVolumeRequests(requests)).toEqual([]);
});

test("destroy --volumes inspects the history volume for removal", async () => {
  const { api, requests } = recordingApi();
  await Effect.runPromise(
    bringDown(historyPlan, {
      api,
      ctx: { providerId: "docker", remediation: "retry" },
      dialect: dockerLifecycleDialect,
      volumes: true,
    }),
  );
  expect(historyVolumeRequests(requests).some((request) => request.method === "GET")).toBe(true);
});

test("destroy --purge-caches leaves the history data volume", async () => {
  const { api, requests } = recordingApi();
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
