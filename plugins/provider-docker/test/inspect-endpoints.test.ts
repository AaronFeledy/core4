import { expect, test } from "bun:test";
import { type DockerApiClient, makeRuntimeProvider } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

const name = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-27T00:00:00Z"),
  source: "test",
  runtime: 4,
} as const;
const service = {
  name,
  type: "lando",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata,
  endpoints: [
    { _tag: "published", protocol: "https", port: 443, name: "websecure", publication: {} },
    { _tag: "published", protocol: "tcp", port: 6379, name: "redis", publication: {} },
  ],
} as const satisfies ServicePlan;
const plan: AppPlan = {
  id: AppId.make("endpoint-test"),
  name: "endpoint-test",
  slug: "endpoint-test",
  root: AbsolutePath.make("/tmp/endpoint-test"),
  provider: providerId,
  services: { [name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata,
};
const inspectBody = JSON.stringify({
  State: { Running: true },
  NetworkSettings: {
    Ports: {
      "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "8443" }],
      "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "16379" }],
    },
  },
});

test("Docker inspect reports actual transport without planned HTTP metadata", async () => {
  // Given
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: () => Effect.succeed({ status: 200, body: inspectBody }),
  };
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  // When
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
  // Then
  expect(result.publications).toEqual({
    status: "present",
    bindings: [
      { port: 443, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8443 },
      { port: 6379, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 16379 },
    ],
  });
});

test("Docker list leaves planless TCP bindings as TCP rather than guessing HTTP", async () => {
  // Given
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (input) =>
      Effect.succeed({
        status: 200,
        body: input.path.startsWith("/containers/json")
          ? JSON.stringify([
              {
                Id: "test-container",
                Names: ["/lando-endpoint-test-web"],
                State: "running",
                Labels: { "dev.lando.app": plan.id, "dev.lando.service": name },
              },
            ])
          : inspectBody,
      }),
  };
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  // When
  const result = await Effect.runPromise(provider.list({ app: plan.id }));
  // Then
  expect(result.map((runtime) => runtime.publications)).toEqual([
    {
      status: "present",
      bindings: [
        { port: 443, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8443 },
        { port: 6379, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 16379 },
      ],
    },
  ]);
});

test.each([
  { status: 404, body: "{}", observation: { status: "missing" } },
  { status: 200, body: "{}", observation: { status: "unknown" } },
  { status: 200, body: '{"NetworkSettings":{"Ports":{}}}', observation: { status: "present", bindings: [] } },
])(
  "Docker inspect distinguishes publication evidence: $observation",
  async ({ status, body, observation }) => {
    // Given
    const api: DockerApiClient = {
      info: Effect.succeed({}),
      request: () => Effect.succeed({ status, body }),
    };
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
    // When
    const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
    // Then
    expect(result.publications).toEqual(observation);
    expect(result).not.toHaveProperty("endpoints");
  },
);

test.each(["paused", "restarting"])(
  "Docker inspect preserves %s without inferring binding health",
  async (state) => {
    // Given
    const body = JSON.parse(inspectBody);
    const api: DockerApiClient = {
      info: Effect.succeed({}),
      request: () =>
        Effect.succeed({
          status: 200,
          body: JSON.stringify({ ...body, State: { Running: true, Status: state } }),
        }),
    };
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
    // When
    const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
    // Then
    expect(result.state).toBe(state);
    expect(result.health).toBeUndefined();
    expect(result.publications.status).toBe("present");
  },
);

test.each([
  { status: 404, body: "{}", observation: { status: "missing" } },
  { status: 500, body: '{"message":"daemon said list-inspect-canary"}', observation: { status: "unknown" } },
  {
    status: 200,
    body: '{"NetworkSettings":{"Ports":{"80/tcp":null}}}',
    observation: { status: "present", bindings: [] },
  },
])(
  "Docker list keeps per-container inspect evidence honest: HTTP $status",
  async ({ status, body, observation }) => {
    // Given a discovered container whose follow-up inspect returns the case response.
    const api: DockerApiClient = {
      info: Effect.succeed({}),
      request: (input) =>
        Effect.succeed(
          input.path.startsWith("/containers/json")
            ? {
                status: 200,
                body: JSON.stringify([
                  {
                    Id: "c",
                    Names: ["/c"],
                    State: "paused",
                    Labels: { "dev.lando.app": plan.id, "dev.lando.service": name },
                  },
                ]),
              }
            : { status, body },
        ),
    };
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
    // When
    const result = await Effect.runPromise(provider.list({ app: plan.id }));
    // Then
    expect(result.map((runtime) => runtime.publications)).toEqual([observation]);
    expect(result[0]?.state).toBe("paused");
    expect(JSON.stringify(result)).not.toContain("list-inspect-canary");
  },
);
