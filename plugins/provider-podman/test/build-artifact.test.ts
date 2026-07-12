import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import type { ContainerBuildHttpRequest } from "@lando/container-runtime/image-build";
import { type PodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("podman");
const appId = AppId.make("podman-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-12T00:00:00Z"),
  source: "provider-podman/build-artifact.test.ts",
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
  storage: [],
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
  name: "Podman Build App",
  slug: "podman-build-app",
  root: AbsolutePath.make("/tmp/podman-build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("provider-podman buildArtifact uses the Podman build API seam", async () => {
  const requests: ContainerBuildHttpRequest[] = [];
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { status: 200, body: "" };
      }),
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      podmanApi,
      platform: "linux",
      env: {},
      conflictDetector: () => Effect.void,
    }),
  );

  const artifact = await Effect.runPromise(
    Effect.scoped(provider.buildArtifact({ app: appId, service: serviceName, plan, buildKey: "podman-key" })),
  );

  expect(artifact).toEqual({ providerId, ref: "lando-build-podman-web-podman-key" });
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.path).toContain("/build?t=lando-build-podman-web-podman-key");
});
