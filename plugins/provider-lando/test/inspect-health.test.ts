import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Duration, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type PlanMetadata,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { PodmanApiClient, PodmanHttpResponse } from "../src/capabilities.ts";
import { waitForServiceHealth } from "../src/health.ts";
import { inspect } from "../src/inspect.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("healthapp");
const appRoot = AbsolutePath.make("/tmp/lando-health-app");
const serviceName = ServiceName.make("web");
const target = { app: appId, service: serviceName };
const metadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "inspect-health.test",
  runtime: 4,
};

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [{ port: 31080, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Health App",
  slug: "healthapp",
  root: appRoot,
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const inspectBody = (health?: string): string =>
  JSON.stringify({
    Id: "lando-healthapp-web-id",
    State: {
      Running: true,
      Status: "running",
      StartedAt: "2026-05-14T00:00:01Z",
      ...(health === undefined ? {} : { Health: { Status: health } }),
    },
  });

const stoppedInspectBody = (health?: string): string =>
  JSON.stringify({
    Id: "lando-healthapp-web-id",
    State: {
      Running: false,
      Status: "exited",
      StartedAt: "2026-05-14T00:00:01Z",
      ...(health === undefined ? {} : { Health: { Status: health } }),
    },
  });

const apiFromResponses = (responses: ReadonlyArray<PodmanHttpResponse>) => {
  let calls = 0;
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: () =>
      Effect.sync(() => {
        const response = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return response;
      }),
  };
  return { api, calls: () => calls };
};

const apiWithHealth = (health?: string) => apiFromResponses([{ status: 200, body: inspectBody(health) }]);

const expectProviderUnavailable = (exit: Exit.Exit<unknown, unknown>): ProviderUnavailableError => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some" && failure.value instanceof ProviderUnavailableError) {
      return failure.value;
    }
  }
  throw new Error("Expected ProviderUnavailableError");
};

describe("provider-lando inspect health", () => {
  test.each(["healthy", "starting", "unhealthy"])(
    "maps Podman State.Health.Status=%s onto ServiceRuntimeInfo.health",
    async (health) => {
      const fake = apiWithHealth(health);

      const info = await Effect.runPromise(inspect(plan, target, { podmanApi: fake.api }));

      expect(info.health).toBe(health);
    },
  );

  test("leaves health undefined when Podman inspect has no Health field", async () => {
    const fake = apiWithHealth();

    const info = await Effect.runPromise(inspect(plan, target, { podmanApi: fake.api }));

    expect(info.health).toBeUndefined();
    expect(info.status).toBe("running");
  });

  test("leaves health undefined when Podman health status is malformed", async () => {
    const fake = apiWithHealth("weird");

    const info = await Effect.runPromise(inspect(plan, target, { podmanApi: fake.api }));

    expect(info.health).toBeUndefined();
  });
});

describe("waitForServiceHealth", () => {
  test("resolves immediately when the service is healthy", async () => {
    const fake = apiWithHealth("healthy");

    const info = await Effect.runPromise(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 3, delay: Duration.zero },
      }),
    );

    expect(info.health).toBe("healthy");
    expect(fake.calls()).toBe(1);
  });

  test("retries starting services until they become healthy", async () => {
    const fake = apiFromResponses([
      { status: 200, body: inspectBody("starting") },
      { status: 200, body: inspectBody("healthy") },
    ]);

    const info = await Effect.runPromise(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 3, delay: Duration.zero },
      }),
    );

    expect(info.health).toBe("healthy");
    expect(fake.calls()).toBe(2);
  });

  test("fails with ProviderUnavailableError when the service stays unhealthy", async () => {
    const fake = apiWithHealth("unhealthy");

    const exit = await Effect.runPromiseExit(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 2, delay: Duration.zero },
      }),
    );

    const error = expectProviderUnavailable(exit);
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain(String(serviceName));
    expect(JSON.stringify(error.details)).toContain('"attempts":2');
  });

  test("resolves immediately when the service has no container healthcheck", async () => {
    const fake = apiWithHealth();

    const info = await Effect.runPromise(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 3, delay: Duration.zero },
      }),
    );

    expect(info.health).toBeUndefined();
    expect(fake.calls()).toBe(1);
  });

  test("fails when a stopped service has no container healthcheck", async () => {
    const fake = apiFromResponses([{ status: 200, body: stoppedInspectBody() }]);

    const exit = await Effect.runPromiseExit(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 1, delay: Duration.zero },
      }),
    );

    const error = expectProviderUnavailable(exit);
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain(String(serviceName));
  });

  test("fails when a stopped service reports stale healthy status", async () => {
    const fake = apiFromResponses([{ status: 200, body: stoppedInspectBody("healthy") }]);

    const exit = await Effect.runPromiseExit(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 1, delay: Duration.zero },
      }),
    );

    const error = expectProviderUnavailable(exit);
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain(String(serviceName));
  });

  test("maps probe timeout to ProviderUnavailableError", async () => {
    const fake = apiWithHealth("starting");

    const exit = await Effect.runPromiseExit(
      waitForServiceHealth(plan, target, {
        podmanApi: fake.api,
        policy: { maxAttempts: 50, delay: Duration.millis(1), timeout: Duration.millis(1) },
      }),
    );

    const error = expectProviderUnavailable(exit);
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain(String(serviceName));
  });

  test("redacts probe lastError before surfacing failure details", async () => {
    const secretUrl = "https://user:secretpass@registry.example.com/x";
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      request: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "inspect",
            message: `failed to reach ${secretUrl}`,
            details: { url: secretUrl },
          }),
        ),
    };

    const exit = await Effect.runPromiseExit(
      waitForServiceHealth(plan, target, {
        podmanApi: api,
        policy: { maxAttempts: 1, delay: Duration.zero },
      }),
    );

    const error = expectProviderUnavailable(exit);
    expect(error.message).not.toContain("secretpass");
    expect(JSON.stringify(error.details)).not.toContain("secretpass");
  });
});
