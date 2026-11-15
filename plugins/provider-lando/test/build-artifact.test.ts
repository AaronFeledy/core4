import { expect, test } from "bun:test";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { type PodmanApiClient, type PodmanHttpRequest, makeRuntimeProvider } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { runScoped } from "./scope-helpers.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("lando-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-12T00:00:00Z"),
  source: "provider-lando/build-artifact.test.ts",
  runtime: 4 as const,
};

const servicePlan: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "debian:12.11-slim" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [
        { id: "redirect", phase: "build", command: ["ln", "-sf", "/dev/stdout", "/logs/access.log"] },
      ],
    },
  },
};

const plan: AppPlan = {
  id: appId,
  name: "Lando Build App",
  slug: "lando-build-app",
  root: AbsolutePath.make("/tmp/lando-build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("provider-lando buildArtifact uses the managed Podman build API seam", async () => {
  const requests: PodmanHttpRequest[] = [];
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { status: 200, body: "{}" };
      }),
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({ sanitizeAppliedPlan: stripHostProxyRunLando, podmanApi, platform: "linux" }),
  );

  const artifact = await runScoped(
    provider.buildArtifact({
      labels: { "dev.lando.test": crypto.randomUUID() },
      app: appId,
      service: serviceName,
      plan,
      buildKey: "lando-key",
      ref: "chosen-by-engine:lando",
    }),
  );

  expect(artifact).toEqual({ providerId, ref: "chosen-by-engine:lando" });
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.path).toContain("/build?t=chosen-by-engine%3Alando");
  expect(requests[1]).toEqual({
    method: "GET",
    path: "/images/chosen-by-engine%3Alando/json",
  });
  expect(await Effect.runPromise(provider.removeArtifact(artifact))).toEqual({ kind: "removed" });
  expect(requests.slice(2).every((request) => request.method === "DELETE")).toBe(true);
});

test("artifact removal reports a stopped managed runtime without starting it", async () => {
  let running = true;
  const offline = new ProviderUnavailableError({
    providerId,
    operation: "request",
    message: "socket refused",
    remediation: "Start the runtime.",
  });
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      platform: "linux",
      sanitizeAppliedPlan: stripHostProxyRunLando,
      podmanApi: {
        info: Effect.suspend(() =>
          running
            ? Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } })
            : Effect.fail(offline),
        ),
        ping: Effect.suspend(() => (running ? Effect.void : Effect.fail(offline))),
        request: () => Effect.fail(offline),
      },
      providerSocketPath: "/unused/socket",
      providerPidPath: "/unused/pid",
      runtimeStorageDir: "/unused/storage",
      runtimeRunDir: "/unused/run",
      runtimeConfigDir: "/unused/config",
      runtimeLock: () => Effect.die("removal must not acquire the runtime launch lock"),
    }),
  );
  running = false;
  const failure = await Effect.runPromise(
    Effect.flip(provider.removeArtifact({ providerId, ref: "test:offline" })),
  );
  expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "removeArtifact" });
});
