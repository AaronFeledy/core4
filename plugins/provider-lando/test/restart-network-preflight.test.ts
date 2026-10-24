import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  CREATE_CONFIG_LABEL,
  retainCreateArtifactIdentity,
} from "@lando/container-runtime/create-fingerprint";
import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { commonContainerLabels } from "@lando/container-runtime/plan";
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
const declared: ServicePlan = {
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
const service = retainCreateArtifactIdentity(declared, {
  ...declared,
  artifact: { kind: "ref", ref: "lando-build-web", digest: "sha256:built" },
});
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

test.each([
  { scenario: "unchanged networks", missing: false, changed: false },
  { scenario: "missing physical label", missing: false, changed: false, proof: "missing" },
  { scenario: "stale physical label", missing: false, changed: false, proof: "stale" },
  { scenario: "old fingerprint version", missing: false, changed: false, proof: "old" },
  { scenario: "logical labels without physical proof", missing: false, changed: false, logicalLabels: true },
  { scenario: "missing network", missing: true, changed: false },
  {
    scenario: "changed immutable command versus old physical labels still reports config",
    missing: false,
    changed: true,
  },
])("Windows restart preflight: $scenario", async ({ missing, changed, logicalLabels, proof }) => {
  // Given a container attached to the current machine's physical networks.
  const createdAt = "2026-10-09T00:00:00Z";
  const physical = windowsMachineNetworkPlan(plan, createdAt);
  const physicalService = physical.services[service.name];
  if (physicalService === undefined) throw new Error("Missing physical web service fixture");
  const desiredService: ServicePlan = changed ? { ...service, command: ["nginx", "-t"] } : service;
  const desired: AppPlan = { ...plan, services: { [service.name]: desiredService } };
  const names = [
    physical.networking?.perAppBridge?.name,
    physical.networking?.sharedNetworkMembership?.name,
  ].filter((name): name is string => name !== undefined);
  const labels = { ...commonContainerLabels(logicalLabels ? plan : physical, physicalService) };
  if (proof === "missing") delete labels[CREATE_CONFIG_LABEL];
  if (proof === "stale") labels[CREATE_CONFIG_LABEL] = "v2:stale";
  if (proof === "old")
    labels[CREATE_CONFIG_LABEL] = labels[CREATE_CONFIG_LABEL]?.replace(/^v2:/, "v1:") ?? "v1:old";
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: () =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify({
          Id: "existing-web",
          Config: { Labels: labels },
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
  const runtime = await Effect.runPromise(
    provider.inspect({ app: desired.id, service: service.name, plan: desired }),
  );
  // Then physical naming alone is not drift, but a missing attachment is.
  expect(bringUpRecreateReasons(desired, desiredService, runtime, { skipAbsentFields: true })).toEqual(
    changed || logicalLabels || proof !== undefined ? ["config"] : missing ? ["network"] : [],
  );
});
