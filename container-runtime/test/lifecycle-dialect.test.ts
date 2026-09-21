import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { dockerLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("lifecycle-dialect-app");
const serviceName = ServiceName.make("web");
const ctx = { providerId: "docker", remediation: "Repair Docker and retry." } as const;
const service: ServicePlan = {
  name: serviceName,
  type: "generic",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "example/web:latest" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-20T00:00:00Z"),
    source: "container-runtime/lifecycle-dialect.test.ts",
    runtime: 4,
  },
  extensions: {},
};
const plan: AppPlan = {
  id: appId,
  name: "Lifecycle Dialect App",
  slug: "lifecycle-dialect-app",
  root: AbsolutePath.make("/tmp/lifecycle-dialect-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: service.metadata,
  extensions: {},
};

const makeBringUpApi = (
  createResponses: ReadonlyArray<EngineHttpResponse> = [{ status: 201, body: "{}" }],
  options: { readonly existing?: boolean } = {},
) => {
  const requests: EngineHttpRequest[] = [];
  let created = options.existing === true;
  let createIndex = 0;
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && request.path.endsWith("/json")) {
          return created
            ? { status: 200, body: JSON.stringify({ State: { Running: true, Status: "running" } }) }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create?")) {
          const response = createResponses[Math.min(createIndex, createResponses.length - 1)] ?? {
            status: 201,
            body: "{}",
          };
          createIndex += 1;
          created = response.status === 201 || response.status === 409;
          return response;
        }
        if (request.method === "POST" && request.path.endsWith("/connect")) {
          return { status: 200, body: "{}" };
        }
        if (request.method === "POST" && request.path.endsWith("/start")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, requests };
};

describe("lifecycle dialect", () => {
  test("connects each created container to the shared network after ensuring its image", async () => {
    // Given
    const fake = makeBringUpApi();
    const calls: string[] = [];

    // When
    await Effect.runPromise(
      bringUp(plan, {
        api: fake.api,
        ctx,
        dialect: dockerLifecycleDialect,
        ensureImage: ({ force }) => Effect.sync(() => calls.push(`ensure:${force}`)).pipe(Effect.asVoid),
      }),
    );

    // Then
    const createIndex = fake.requests.findIndex((request) => request.path.startsWith("/containers/create?"));
    const connectRequests = fake.requests.filter((request) => request.path.endsWith("/connect"));
    expect(calls).toEqual(["ensure:false"]);
    expect(createIndex).toBeGreaterThan(-1);
    expect(connectRequests).toHaveLength(1);
    expect(connectRequests[0]).toMatchObject({
      method: "POST",
      path: "/networks/lando_bridge_network/connect",
      body: {
        Container: "lando-lifecycle-dialect-app-web",
        EndpointConfig: { Aliases: ["web.lifecycle-dialect-app.internal"] },
      },
    });
    const createBody = fake.requests[createIndex]?.body;
    expect(createBody).toMatchObject({
      NetworkingConfig: {
        EndpointsConfig: { "lando-lifecycle-dialect-app": { Aliases: ["web"] } },
      },
    });
  });

  test("reconnects an existing container to the shared network", async () => {
    const fake = makeBringUpApi([{ status: 201, body: "{}" }], { existing: true });

    await Effect.runPromise(
      bringUp(plan, {
        api: fake.api,
        ctx,
        dialect: dockerLifecycleDialect,
      }),
    );

    expect(fake.requests.some((request) => request.path.startsWith("/containers/create?"))).toBe(false);
    expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toEqual([
      {
        method: "POST",
        path: "/networks/lando_bridge_network/connect",
        body: {
          Container: "lando-lifecycle-dialect-app-web",
          EndpointConfig: { Aliases: ["web.lifecycle-dialect-app.internal"] },
        },
      },
    ]);
  });

  test("forces one image ensure and retries create once after a missing-image response", async () => {
    // Given
    const fake = makeBringUpApi([
      { status: 404, body: '{"message":"No such image: example/web:latest"}' },
      { status: 201, body: "{}" },
    ]);
    const forces: boolean[] = [];

    // When
    await Effect.runPromise(
      bringUp(plan, {
        api: fake.api,
        ctx,
        dialect: dockerLifecycleDialect,
        ensureImage: ({ force }) => Effect.sync(() => forces.push(force)).pipe(Effect.asVoid),
        retryCreateOnMissingImage: true,
      }),
    );

    // Then
    expect(forces).toEqual([false, true]);
    expect(fake.requests.filter((request) => request.path.startsWith("/containers/create?"))).toHaveLength(2);
  });

  test("skips the libpod volume prune endpoint for the Docker lifecycle dialect", async () => {
    // Given
    const requests: EngineHttpRequest[] = [];
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return { status: 404, body: "{}" };
        }),
    };

    // When
    await Effect.runPromise(bringDown(plan, { api, ctx, dialect: dockerLifecycleDialect, volumes: true }));

    // Then
    expect(requests.some((request) => request.path.startsWith("/libpod/volumes/prune"))).toBe(false);
  });
});
