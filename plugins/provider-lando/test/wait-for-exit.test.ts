import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";
import { waitForExit } from "../src/inspect.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("wait-for-exit-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "provider-lando/wait-for-exit.test.ts",
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
const target = { app: appId, service: serviceName };

const makeFakeApi = (response: PodmanHttpResponse) => {
  const calls: PodmanHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: (input) => {
      calls.push(input);
      return Effect.succeed(response);
    },
  };
  return { api, calls };
};

describe("provider-lando waitForExit", () => {
  test("returns the exit code from the container wait response", async () => {
    // Given
    const fake = makeFakeApi({ status: 200, body: '{"StatusCode":137}' });

    // When
    const result = await Effect.runPromise(waitForExit(plan, target, { podmanApi: fake.api }));

    // Then
    expect(result).toEqual({ exitCode: 137 });
    expect(fake.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/containers/lando-wait-for-exit-app-web/wait" },
    ]);
  });

  test("fails when the wait response has no numeric exit code", async () => {
    // Given
    const fake = makeFakeApi({ status: 200, body: '{"StatusCode":null}' });

    // When
    const failure = await Effect.runPromise(Effect.flip(waitForExit(plan, target, { podmanApi: fake.api })));

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });
});
