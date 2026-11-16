import { expect, test } from "bun:test";
import type { EngineHttpRequest, PodmanApiClient } from "@lando/container-runtime/engine-api";
import { commonContainerLabels, serviceContainerName } from "@lando/container-runtime/plan";
import { makeRuntimeProvider } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

import { windowsMachineNetworkPlan } from "../src/windows-machine-network.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: AppId.make("inspect-physical"),
  name: "Inspect Physical",
  slug: "inspect-physical",
  root: AbsolutePath.make("/tmp/inspect-physical"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
  networking: landoNetworkingPlan({
    slug: "inspect-physical",
    serviceNames: ["web"],
    sharedCrossAppNetwork: true,
    authoredNetworks: [{ key: "extra", external: false, members: { web: [] } }],
  }),
};

test("inspects the physical container and reports its physical create evidence", async () => {
  // Given a container created under the machine's physical network naming.
  const createdAt = "2026-10-09T00:00:00Z";
  const physical = windowsMachineNetworkPlan(plan, createdAt);
  const physicalService = physical.services[service.name];
  if (physicalService === undefined) throw new Error("Missing physical web service fixture");
  const labels = commonContainerLabels(physical, physicalService);
  const requests: EngineHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return {
          status: 200,
          body: JSON.stringify({
            Id: "existing-web",
            Config: { Labels: labels },
            State: { Running: true },
            Mounts: [],
            HostConfig: { PortBindings: {} },
            NetworkSettings: { Networks: { physical: {} } },
          }),
        };
      }),
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      platform: "win32",
      providerSocketPath: "\\\\.\\pipe\\podman-lando",
      podmanApi: api,
      podmanMachine: {
        inspect: Effect.succeed("running"),
        createdAt: Effect.succeed(createdAt),
        create: Effect.void,
        start: Effect.void,
        stop: Effect.void,
        upgrade: Effect.void,
        teardown: Effect.void,
      },
      sanitizeAppliedPlan: (value) => value,
    }),
  );

  // When the provider observes the service.
  const runtime = await Effect.runPromise(provider.inspect({ app: plan.id, service: service.name, plan }));

  // Then it asks for the physical container and reports that container's labels unchanged.
  expect(requests[0]?.path).toContain(serviceContainerName(physical, service.name));
  expect(runtime.labels).toEqual(labels);
  expect(runtime.containerId).toBe("existing-web");
  expect(runtime).not.toHaveProperty("networkNames");
  expect(runtime).not.toHaveProperty("publishFingerprint");
  expect(runtime).not.toHaveProperty("bindSources");
});
