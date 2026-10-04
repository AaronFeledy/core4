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
  storage: [],
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

test("Docker inspect preserves planned protocols with observed host bindings", async () => {
  // Given
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: () => Effect.succeed({ status: 200, body: inspectBody }),
  };
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  // When
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
  // Then
  expect(result.endpoints).toEqual([
    { ...service.endpoints[0], materialization: { bindAddress: "127.0.0.1", hostPort: 8443 } },
    { ...service.endpoints[1], materialization: { bindAddress: "127.0.0.1", hostPort: 16379 } },
  ]);
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
  expect(result.flatMap((runtime) => runtime.endpoints?.map((endpoint) => endpoint.protocol) ?? [])).toEqual([
    "tcp",
    "tcp",
  ]);
});
