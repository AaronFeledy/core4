import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { type PodmanApiClient, type PodmanHttpRequest, makeRuntimeProvider } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const appId = AppId.make("lando-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-12T00:00:00Z"),
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
  name: "Lando Build App",
  slug: "lando-build-app",
  root: AbsolutePath.make("/tmp/lando-build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
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
  const provider = await Effect.runPromise(makeRuntimeProvider({ podmanApi, platform: "linux" }));

  const artifact = await Effect.runPromise(
    provider.buildArtifact({ app: appId, service: serviceName, plan, buildKey: "lando-key" }),
  );

  expect(artifact).toEqual({ providerId, ref: "lando-build-lando-web-lando-key" });
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.path).toContain("/build?t=lando-build-lando-web-lando-key");
  expect(requests[1]).toEqual({
    method: "GET",
    path: "/images/lando-build-lando-web-lando-key/json",
  });
});
