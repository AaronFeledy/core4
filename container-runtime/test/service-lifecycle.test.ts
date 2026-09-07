import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { postServiceLifecycle } from "../src/service-lifecycle.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("lifecycle-app");
const serviceName = ServiceName.make("web");
const lifecycleActions = ["start", "stop", "restart"] as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "container-runtime/service-lifecycle.test.ts",
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
  name: "Lifecycle App",
  slug: "lifecycle-app",
  root: AbsolutePath.make("/tmp/lifecycle-app"),
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

describe.each(["docker", "lando", "podman"] as const)("%s service lifecycle", (providerName) => {
  const ctx = { providerId: providerName, remediation: `Repair ${providerName} and retry.` } as const;

  for (const action of lifecycleActions) {
    test(`issues only POST /${action} for the planned container`, async () => {
      // Given
      const calls: EngineHttpRequest[] = [];
      const api: EngineHttpApi = {
        request: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return { status: 204, body: "" };
          }),
      };

      // When
      await Effect.runPromise(postServiceLifecycle(plan, target, action, { api, ctx }));

      // Then
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.path).toBe(`/containers/lando-lifecycle-app-web/${action}`);
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    });

    test(`treats HTTP 304 as success for ${action}`, async () => {
      // Given
      const api: EngineHttpApi = { request: () => Effect.succeed({ status: 304, body: "" }) };

      // When
      const result = await Effect.runPromise(postServiceLifecycle(plan, target, action, { api, ctx }));

      // Then
      expect(result).toBeUndefined();
    });

    test(`maps HTTP 404 to ServiceNotFoundError for ${action}`, async () => {
      // Given
      const api: EngineHttpApi = { request: () => Effect.succeed({ status: 404, body: "" }) };

      // When
      const failure = await Effect.runPromise(
        postServiceLifecycle(plan, target, action, { api, ctx }).pipe(Effect.flip),
      );

      // Then
      expect(failure).toBeInstanceOf(ServiceNotFoundError);
      expect(failure.providerId).toBe(providerName);
    });
  }
});

describe("service lifecycle failures", () => {
  const ctx = { providerId: "podman", remediation: "Repair Podman and retry." } as const;

  test("fails when the service is absent from the plan", async () => {
    // Given
    const missingTarget = { app: appId, service: ServiceName.make("missing") };

    // When
    const failure = await Effect.runPromise(
      postServiceLifecycle(plan, missingTarget, "start", { api: {}, ctx }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ServiceNotFoundError);
  });

  test("fails through missingApi when request support is absent", async () => {
    // Given / When
    const failure = await Effect.runPromise(
      postServiceLifecycle(plan, target, "start", { api: {}, ctx }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.providerId).toBe("podman");
    expect(failure.remediation).toBe(ctx.remediation);
  });

  test("preserves the request failure as the cause of ProviderUnavailableError", async () => {
    // Given
    const requestFailure = new ProviderInternalError({
      providerId: "podman",
      operation: "podman-api",
      message: "socket parse failed",
    });
    const api: EngineHttpApi = { request: () => Effect.fail(requestFailure) };

    // When
    const failure = await Effect.runPromise(
      postServiceLifecycle(plan, target, "restart", { api, ctx }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.cause).toBe(requestFailure);
    expect(failure.providerId).toBe("podman");
  });

  test("adds a redacted API reason to non-success status messages", async () => {
    // Given
    const api: EngineHttpApi = {
      request: () => Effect.succeed({ status: 500, body: '{"message":"daemon rejected request"}' }),
    };

    // When
    const failure = await Effect.runPromise(
      postServiceLifecycle(plan, target, "stop", { api, ctx }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toBe("Container stop failed with HTTP 500. daemon rejected request");
    expect(failure.remediation).toBe(ctx.remediation);
  });
});
