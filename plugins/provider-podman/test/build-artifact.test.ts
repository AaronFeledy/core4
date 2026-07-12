import { expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { type PodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
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
  const requests: string[] = [];
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${request.path}`);
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
  expect(requests[0]).toStartWith("POST ");
  expect(requests[0]).toContain("/build?t=lando-build-podman-web-podman-key");
});

test("provider-podman pullArtifact uses the Podman pull stream seam", async () => {
  const encoder = new TextEncoder();
  const paths: string[] = [];
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    stream: (request) => {
      paths.push(request.path);
      return Stream.fromIterable([encoder.encode('{"stream":"Trying to pull alpine..."}\n')]);
    },
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      podmanApi,
      platform: "linux",
      env: {},
      conflictDetector: () => Effect.void,
    }),
  );

  const artifact = await Effect.runPromise(provider.pullArtifact({ ref: "docker.io/library/alpine:3.20.3" }));

  expect(artifact).toEqual({ providerId, ref: "docker.io/library/alpine:3.20.3" });
  expect(paths[0]).toContain("/libpod/images/pull");
  expect(paths[0]).toContain("pullProgress=true");
});

test("provider-podman pullArtifact failures report providerId podman", async () => {
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.succeed(undefined),
    stream: () => Stream.fromIterable([new TextEncoder().encode('{"error":"manifest unknown"}\n')]),
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      podmanApi,
      platform: "linux",
      env: {},
      conflictDetector: () => Effect.void,
    }),
  );

  const error = await Effect.runPromise(
    provider.pullArtifact({ ref: "docker.io/library/missing:latest" }).pipe(Effect.flip),
  );

  expect(error).toBeInstanceOf(ProviderUnavailableError);
  expect(error.providerId).toBe("podman");
});
