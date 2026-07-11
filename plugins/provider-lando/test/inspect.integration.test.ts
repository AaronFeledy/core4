import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, inspect, makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("inspectapp");
const appRoot = AbsolutePath.make("/tmp/lando-inspect-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "inspect.integration.test",
  runtime: 4 as const,
};

const servicePlan = (name: "node" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "node" ? "node" : "postgres",
  provider: providerId,
  primary: name === "node",
  artifact: { kind: "ref", ref: name === "node" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "node" ? ["node", "-e", "setInterval(() => {}, 1000)"] : ["postgres", "-c", "port=55434"],
  environment: name === "node" ? {} : { POSTGRES_PASSWORD: "lando", POSTGRES_DB: "lando" },
  appMount:
    name === "node"
      ? {
          source: appRoot,
          target: PortablePath.make("/app"),
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough",
        }
      : undefined,
  mounts: [],
  storage: [],
  endpoints:
    name === "node"
      ? [{ port: 31082, protocol: "http", name: "http" }]
      : [{ port: 55434, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "node" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const database = servicePlan("database");
const node = servicePlan("node");

const plan: AppPlan = {
  id: appId,
  name: "Inspect App",
  slug: "inspectapp",
  root: appRoot,
  provider: providerId,
  services: { [database.name]: database, [node.name]: node },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const calls: PodmanHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];

        if (request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          if (!existing.has(name)) {
            return { status: 404, body: "{}" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              State: {
                Running: running.has(name),
                Status: running.has(name) ? "running" : "exited",
                StartedAt: running.has(name) ? "2026-05-14T00:00:01Z" : "0001-01-01T00:00:00Z",
              },
            }),
          };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && action === "stop") {
          running.delete(name);
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };

  return { api, calls, existing, running };
};

describe("provider-lando inspect", () => {
  test("returns one structured snapshot per service without mutating provider state", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: fake.api }))),
    );

    await Effect.runPromise(provider.apply(plan, { reconcile: true }).pipe(Effect.scoped));
    const snapshots = await Effect.runPromise(provider.list({ app: appId }));

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => String(snapshot.service)).sort()).toEqual(["database", "node"]);
    for (const snapshot of snapshots) {
      expect(snapshot.state).toBe("running");
      expect(snapshot.status).toBe("running");
      expect(snapshot.containerId).toBe(`lando-inspectapp-${snapshot.service}-id`);
      expect(snapshot.endpoints).toEqual(plan.services[snapshot.service]?.endpoints);
    }
    const callsBeforeInspect = fake.calls.length;
    await Effect.runPromise(provider.inspect({ app: appId, service: node.name }));
    const inspectCalls = fake.calls.slice(callsBeforeInspect);
    expect(inspectCalls.every((call) => call.method === "GET")).toBe(true);
    expect(fake.running.size).toBe(2);
  });

  test("reports a stopped service without starting or removing it", async () => {
    const fake = makeFakeApi();
    fake.existing.add("lando-inspectapp-node");

    const snapshot = await Effect.runPromise(
      inspect(plan, { app: appId, service: node.name }, { podmanApi: fake.api }),
    );

    expect(snapshot).toMatchObject({
      app: appId,
      service: node.name,
      providerId,
      state: "stopped",
      status: "stopped",
      containerId: "lando-inspectapp-node-id",
      endpoints: node.endpoints,
    });
    expect(fake.calls).toEqual([{ method: "GET", path: "/containers/lando-inspectapp-node/json" }]);
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "inspects live Podman services after bringUp",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");

      await Effect.runPromise(bringUp(plan, { podmanApi: api }));
      try {
        const snapshot = await Effect.runPromise(
          inspect(plan, { app: appId, service: node.name }, { podmanApi: api }),
        );

        expect(snapshot.state).toBe("running");
        expect(snapshot.endpoints).toEqual(node.endpoints);
      } finally {
        await Effect.runPromise(bringDown(plan, { podmanApi: api }));
      }
    },
    60_000,
  );
});
