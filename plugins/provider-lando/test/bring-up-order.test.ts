import { expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { type PodmanApiClient, type PodmanHttpRequest, bringUp } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const appId = AppId.make("bring-up-order-app");
const dbName = ServiceName.make("db");
const dependentNames = {
  web: ServiceName.make("web"),
  cache: ServiceName.make("cache"),
};
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "provider-lando/bring-up-order.test.ts",
  runtime: 4 as const,
};

const servicePlan = (name: ServicePlan["name"], primary: boolean): ServicePlan => ({
  name,
  type: "generic",
  provider: providerId,
  primary,
  artifact: { kind: "ref", ref: "debian:12.11-slim" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const planWithDependency = (dependentName: ServicePlan["name"], required: boolean): AppPlan => {
  const db: ServicePlan = {
    ...servicePlan(dbName, false),
    healthcheck: {
      kind: "command",
      command: ["pg_isready"],
      intervalSeconds: 0,
      timeoutSeconds: 5,
      retries: 1,
    },
  };
  const dependent: ServicePlan = {
    ...servicePlan(dependentName, true),
    dependsOn: [{ service: dbName, condition: "service_healthy", required }],
  };

  return {
    id: appId,
    name: "Bring Up Order App",
    slug: "bring-up-order-app",
    root: AbsolutePath.make("/tmp/bring-up-order-app"),
    provider: providerId,
    services: { [dependentName]: dependent, [dbName]: db },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makePodmanApi = (healthExitCode: number) => {
  const requests: string[] = [];
  const containers = new Set<string>();
  const running = new Set<string>();
  const record = (request: PodmanHttpRequest) => requests.push(`${request.method} ${request.path}`);
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        record(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/json|\/start|\/stop)?/u);
        const name = containerMatch?.[1];
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 200, body: "{}" };
        }
        if (request.method === "GET" && request.path.endsWith("/json") && name !== undefined) {
          return containers.has(name)
            ? { status: 200, body: JSON.stringify({ State: { Running: running.has(name) } }) }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create?name=")) {
          containers.add(request.path.slice("/containers/create?name=".length));
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && request.path.endsWith("/start") && name !== undefined) {
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && request.path.endsWith("/exec")) {
          return { status: 201, body: '{"Id":"health-exec"}' };
        }
        if (request.method === "GET" && request.path === "/exec/health-exec/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: healthExitCode }) };
        }
        if (request.method === "DELETE" && name !== undefined) {
          containers.delete(name);
          running.delete(name);
        }
        return { status: 204, body: "" };
      }),
    stream: (request) => {
      record(request);
      return Stream.empty;
    },
  };
  return { podmanApi, requests };
};

test("starts a service_healthy dependency and probes it before starting the dependent", async () => {
  // Given
  const plan = planWithDependency(dependentNames.web, true);
  const { podmanApi, requests } = makePodmanApi(0);

  // When
  await Effect.runPromise(bringUp(plan, { podmanApi }));

  // Then
  const dbStart = requests.indexOf("POST /containers/lando-bring-up-order-app-db/start");
  const dbExec = requests.indexOf("POST /containers/lando-bring-up-order-app-db/exec");
  const webStart = requests.indexOf("POST /containers/lando-bring-up-order-app-web/start");
  expect(dbStart).toBeGreaterThanOrEqual(0);
  expect(dbExec).toBeGreaterThan(dbStart);
  expect(webStart).toBeGreaterThan(dbExec);
});

test("fails with ServiceStartError naming the unmet gate and rolls back when a required gate fails", async () => {
  // Given
  const plan = planWithDependency(dependentNames.web, true);
  const { podmanApi, requests } = makePodmanApi(1);

  // When
  const error = await Effect.runPromise(bringUp(plan, { podmanApi }).pipe(Effect.flip));

  // Then
  expect(error).toMatchObject({ _tag: "ServiceStartError", service: "web" });
  expect(error.message).toContain("db:healthy");
  expect(requests).not.toContain("POST /containers/lando-bring-up-order-app-web/start");
  expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
  expect(requests.some((request) => request.startsWith("DELETE /containers/"))).toBe(true);
});

test("succeeds without rolling back when only an optional gate fails", async () => {
  // Given
  const plan = planWithDependency(dependentNames.cache, false);
  const { podmanApi, requests } = makePodmanApi(1);

  // When
  const result = await Effect.runPromise(bringUp(plan, { podmanApi }));

  // Then
  expect(result.changed).toBe(true);
  expect(requests).toContain("POST /containers/lando-bring-up-order-app-cache/start");
  expect(requests.filter((request) => request.endsWith("/stop"))).toHaveLength(0);
  expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toHaveLength(0);
});
