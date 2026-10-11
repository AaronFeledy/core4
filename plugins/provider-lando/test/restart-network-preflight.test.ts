import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { bringUpRecreateReasons } from "@lando/container-runtime/podman/bring-up-recreate";
import { makeRuntimeProvider } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

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
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: AppId.make("restart-network"),
  name: "Restart Network",
  slug: "restart-network",
  root: AbsolutePath.make("/tmp/restart-network"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
  networking: {
    perAppBridge: { name: "lando-restart-network", driver: "bridge" },
    sharedNetworkMembership: { name: "lando_bridge_network", aliases: {} },
  },
};

test.each([false, true])("Windows restart preflight detects actual network drift: %s", async (missing) => {
  // Given a container attached to the current machine's physical networks.
  const createdAt = "2026-10-09T00:00:00Z";
  const physical = windowsMachineNetworkPlan(plan, createdAt);
  const names = [
    physical.networking?.perAppBridge.name,
    physical.networking?.sharedNetworkMembership?.name,
  ].filter((name): name is string => name !== undefined);
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: () =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify({
          Id: "existing-web",
          State: { Running: true },
          Mounts: [],
          HostConfig: { PortBindings: {} },
          NetworkSettings: {
            Networks: Object.fromEntries((missing ? names.slice(1) : names).map((name) => [name, {}])),
          },
        }),
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
  // When the public provider inspect surface supplies the restart preflight.
  const runtime = await Effect.runPromise(provider.inspect({ app: plan.id, service: service.name, plan }));
  // Then physical naming alone is not drift, but a missing attachment is.
  expect(bringUpRecreateReasons(plan, service, runtime, { skipAbsentFields: true })).toEqual(
    missing ? ["network"] : [],
  );
});
