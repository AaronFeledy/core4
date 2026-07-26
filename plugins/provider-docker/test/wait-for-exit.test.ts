import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  makeRuntimeProvider,
} from "@lando/provider-docker";
import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("wait-for-exit-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "provider-docker/wait-for-exit.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Wait For Exit App",
  slug: "wait-for-exit-app",
  root: AbsolutePath.make("/tmp/wait-for-exit-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeFakeApi = (responses: ReadonlyArray<DockerHttpResponse>) => {
  const calls: DockerHttpRequest[] = [];
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (input) => {
      calls.push(input);
      return Effect.succeed(
        responses[calls.length - 1] ?? { status: 500, body: '{"message":"unexpected request"}' },
      );
    },
  };
  return { api, calls };
};

const waitForExit = async (api: DockerApiClient, requestedService = serviceName) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(
    Effect.scoped(provider.waitForExit({ app: appId, service: requestedService, plan })),
  );
};

const waitFailure = async (api: DockerApiClient, requestedService = serviceName) =>
  Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        Effect.flatMap(makeRuntimeProvider({ platform: "linux", dockerApi: api }), (provider) =>
          provider.waitForExit({ app: appId, service: requestedService, plan }),
        ),
      ),
    ),
  );

describe("provider-docker waitForExit", () => {
  test("returns exit code zero when the container exits successfully", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: '{"StatusCode":0}' }]);

    // When
    const result = await waitForExit(fake.api);

    // Then
    expect(result).toEqual({ exitCode: 0 });
  });

  test("preserves the exact non-zero container exit code", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: '{"StatusCode":137}' }]);

    // When
    const result = await waitForExit(fake.api);

    // Then
    expect(result).toEqual({ exitCode: 137 });
  });

  test("fails with ServiceNotFoundError when the service is absent from the plan", async () => {
    // Given
    const fake = makeFakeApi([]);

    // When
    const failure = await waitFailure(fake.api, ServiceName.make("missing"));

    // Then
    expect(failure).toBeInstanceOf(ServiceNotFoundError);
  });

  test("fails with ProviderUnavailableError when the API request client is unavailable", async () => {
    // Given
    const api: DockerApiClient = { info: Effect.succeed({}) };

    // When
    const failure = await waitFailure(api);

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
  });

  test("fails with ProviderUnavailableError when the wait request is non-2xx", async () => {
    // Given
    const fake = makeFakeApi([{ status: 500, body: '{"message":"wait failed"}' }]);

    // When
    const failure = await waitFailure(fake.api);

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(fake.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/containers/lando-wait-for-exit-app-web/wait" },
    ]);
  });

  test("fails with ProviderInternalError when wait has no numeric exit code", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: '{"StatusCode":null}' }]);

    // When
    const failure = await waitFailure(fake.api);

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });

  test("uses the container wait response without a second inspect request", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: '{"StatusCode":0}' }]);

    // When
    await waitForExit(fake.api);

    // Then
    expect(fake.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/containers/lando-wait-for-exit-app-web/wait" },
    ]);
  });
});
