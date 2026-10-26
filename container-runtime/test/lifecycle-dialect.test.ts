import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { commonContainerLabels } from "../src/plan.ts";
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
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-20T00:00:00Z"),
    source: "container-runtime/lifecycle-dialect.test.ts",
    runtime: 4,
  },
  extensions: {},
};
const plan: AppPlan = {
  valueModel: 1,
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
  options: { readonly existing?: boolean; readonly plan?: AppPlan } = {},
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
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: "lando-lifecycle-dialect-app-web-id",
                  Config: { Labels: commonContainerLabels(options.plan ?? plan, service) },
                  State: { Running: true, Status: "running" },
                }),
              }
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
  test("preserves the ordered complete resolved environment", async () => {
    // Given
    const environment = {
      PLAIN: "visible",
      TOKEN: "${secret:API_TOKEN}",
      SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
      LAST: "last",
    };
    const appliedPlan = { ...plan, services: { [serviceName]: { ...service, environment } } };
    const fake = makeBringUpApi();
    // When
    await Effect.runPromise(
      bringUp(appliedPlan, {
        api: fake.api,
        ctx,
        dialect: dockerLifecycleDialect,
        resolveServiceEnvironment: () => Effect.succeed({ ...environment, TOKEN: "resolved-canary" }),
      }),
    );
    // Then
    expect(
      fake.requests.find((request) => request.path.startsWith("/containers/create?"))?.body,
    ).toMatchObject({
      Env: [
        "PLAIN=visible",
        "TOKEN=resolved-canary",
        "SSH_AUTH_SOCK=/run/lando/ssh-agent/agent.sock",
        "LAST=last",
      ],
    });
    expect(appliedPlan.services[serviceName]?.environment).toEqual(environment);
    expect(JSON.stringify(appliedPlan)).not.toContain("resolved-canary");
  });

  test("uses the complete callback map without retaining omitted plan variables", async () => {
    // Given
    const appliedPlan = {
      ...plan,
      services: { [serviceName]: { ...service, environment: { PLAIN: "visible", LAST: "last" } } },
    };
    const fake = makeBringUpApi();
    // When
    await Effect.runPromise(
      bringUp(appliedPlan, { api: fake.api, ctx, resolveServiceEnvironment: () => Effect.succeed({}) }),
    );
    // Then
    expect(
      fake.requests.find((request) => request.path.startsWith("/containers/create?"))?.body,
    ).toMatchObject({
      Env: [],
    });
  });

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

  for (const dialect of [dockerLifecycleDialect, libpodLifecycleDialect]) {
    test(`${dialect.engine} uses explicit shared-only membership without a later connect`, async () => {
      // Given
      const globalPlan: AppPlan = {
        ...plan,
        id: AppId.make("not-a-magic-id"),
        name: "global",
        slug: "global",
        networking: landoNetworkingPlan({
          slug: "global",
          serviceNames: ["web"],
          sharedCrossAppNetwork: true,
          perAppBridge: false,
        }),
      };
      const fake = makeBringUpApi();

      // When
      await Effect.runPromise(bringUp(globalPlan, { api: fake.api, ctx, dialect }));

      // Then
      expect(
        fake.requests.find((request) => request.path.startsWith("/containers/create?"))?.body,
      ).toMatchObject({
        NetworkingConfig: {
          EndpointsConfig: { lando_bridge_network: { Aliases: ["web.global.internal"] } },
        },
      });
      expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toEqual([]);
      expect(
        fake.requests.filter((request) => request.path === "/networks/create").map((request) => request.body),
      ).toEqual([{ Name: "lando_bridge_network", Driver: "bridge" }]);
    });
    test(`${dialect.engine} honors a private bridge even with the reserved app id`, async () => {
      const fake = makeBringUpApi();
      const networking = landoNetworkingPlan({
        slug: "shop",
        serviceNames: ["web"],
        sharedCrossAppNetwork: true,
      });
      await Effect.runPromise(
        bringUp({ ...plan, id: AppId.make("global"), networking }, { api: fake.api, ctx, dialect }),
      );
      const create = fake.requests.find((request) => request.path.startsWith("/containers/create?"));
      expect(create?.body).toMatchObject({
        NetworkingConfig: { EndpointsConfig: { "lando-shop": { Aliases: ["web"] } } },
      });
      expect(
        fake.requests
          .filter((request) => request.path === "/networks/create")
          .map((request) =>
            typeof request.body === "object" && request.body !== null
              ? Reflect.get(request.body, "Name")
              : undefined,
          ),
      ).toEqual(["lando-shop", "lando_bridge_network"]);
      expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toHaveLength(
        dialect.engine === "docker" ? 1 : 0,
      );
    });
  }

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

  test("reattaches a global container on later Docker bring-ups without connecting redundantly on creation", async () => {
    const globalPlan: AppPlan = {
      ...plan,
      id: AppId.make("global"),
      slug: "global",
      networking: landoNetworkingPlan({
        slug: "global",
        serviceNames: ["web"],
        sharedCrossAppNetwork: true,
        perAppBridge: false,
      }),
    };
    const fake = makeBringUpApi(undefined, { plan: globalPlan });
    const options = { api: fake.api, ctx, dialect: dockerLifecycleDialect };

    await Effect.runPromise(bringUp(globalPlan, options));
    expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toEqual([]);
    fake.requests.length = 0;

    await Effect.runPromise(bringUp(globalPlan, options));

    expect(fake.requests.some((request) => request.path.startsWith("/containers/create?"))).toBe(false);
    expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toEqual([
      {
        method: "POST",
        path: "/networks/lando_bridge_network/connect",
        body: {
          Container: "lando-global-web",
          EndpointConfig: { Aliases: ["web.global.internal"] },
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

  test("does not ensure or pull-pin a build-only service", async () => {
    const fake = makeBringUpApi();
    const calls: string[] = [];
    const buildPlan: AppPlan = {
      ...plan,
      services: {
        [serviceName]: {
          ...service,
          artifact: {
            kind: "build",
            context: AbsolutePath.make("/tmp/lifecycle-dialect-build"),
            specInline: "FROM scratch",
          },
          extensions: { compose: { build: { platforms: ["linux/amd64"] } } },
        },
      },
    };

    const exit = await Effect.runPromiseExit(
      bringUp(buildPlan, {
        api: fake.api,
        ctx,
        dialect: dockerLifecycleDialect,
        ensureImage: ({ ref, force }) =>
          Effect.sync(() => calls.push(`ensure:${ref}:${force}`)).pipe(Effect.asVoid),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    expect(fake.requests.every((request) => !request.path.includes("/images/create"))).toBe(true);
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
