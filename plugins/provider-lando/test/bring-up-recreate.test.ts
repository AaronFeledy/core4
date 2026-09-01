import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit } from "effect";

import {
  type PodmanApiClient,
  type PodmanHttpRequest,
  type PodmanHttpResponse,
  bringUp,
} from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const appId = AppId.make("recreate-ports");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"),
  source: "provider-lando/bring-up-recreate.test.ts",
  runtime: 4 as const,
};
const containerName = "lando-recreate-ports-web";

const planWithHostPort = (hostPort: number): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [
      {
        _tag: "published",
        port: 8080,
        protocol: "http",
        name: "http",
        publication: { bindAddress: "127.0.0.1", hostPort },
      },
    ],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  return {
    id: appId,
    name: "Recreate Ports",
    slug: "recreate-ports",
    root: AbsolutePath.make("/tmp/lando-recreate-ports"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "recreate-ports-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const inspectBody = (hostPort: string, running: boolean): string =>
  JSON.stringify({
    State: { Running: running },
    HostConfig: {
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }],
      },
    },
  });

const makeFakeApi = (input: { readonly deleteStatus: number }) => {
  const calls: PodmanHttpRequest[] = [];
  let exists = true;
  let running = true;
  let hostPort = "18080";
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          return exists ? { status: 200, body: inspectBody(hostPort, running) } : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && action === "stop") {
          running = false;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && name === containerName) {
          if (input.deleteStatus === 204) {
            exists = false;
            running = false;
          }
          return { status: input.deleteStatus, body: input.deleteStatus === 204 ? "" : "busy" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          if (exists) return { status: 409, body: "already exists" };
          exists = true;
          hostPort = "38080";
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running = true;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls };
};

const createCalls = (calls: ReadonlyArray<PodmanHttpRequest>): ReadonlyArray<PodmanHttpRequest> =>
  calls.filter((call) => call.method === "POST" && call.path.startsWith("/containers/create"));

describe("provider-lando publish-port recreate", () => {
  test("Given a fingerprint mismatch and a failed remove, When bringing up, Then start fails instead of keeping old PortBindings", async () => {
    // Given: existing container still publishes 18080; planned host port is 38080; DELETE is rejected.
    const fake = makeFakeApi({ deleteStatus: 409 });
    const plan = planWithHostPort(38080);

    // When
    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    // Then: recreate must not treat 409-create as success on the leftover container.
    const failures = Exit.isFailure(exit) ? Array.from(Cause.failures(exit.cause)) : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.remove", service: "web" }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("Given a fingerprint mismatch and a successful remove, When bringing up, Then the container is recreated", async () => {
    // Given
    const fake = makeFakeApi({ deleteStatus: 204 });
    const plan = planWithHostPort(38080);

    // When
    const result = await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    // Then
    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
  });
});
