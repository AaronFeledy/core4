import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  type BringDownOptions,
  type ContainerDisposition,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect } from "effect";
import { stopGlobalResources } from "../../src/operations/global-teardown-resources.ts";
import { harness, id, plan, root } from "./global-stop-selection-fixture.ts";

const legacy = {
  app: id,
  appRoot: root,
  providerId: ProviderId.make("lando"),
  service: ServiceName.make("legacy"),
  status: "running" as const,
  containerId: "legacy-container",
  publications: { status: "unknown" as const },
};

test("whole global stop also stops a running owned container the applied plan no longer names", async () => {
  // Given the applied plan's services plus a running owned container for a service it dropped.
  const planned = harness().observed();
  const h = harness({
    observations: [
      ...planned,
      legacy,
      { ...legacy, service: ServiceName.make("idle"), status: "exited", containerId: "idle-container" },
    ],
  });
  const bringDowns: BringDownOptions[] = [];
  const observedStops: Array<readonly [string, ContainerDisposition]> = [];
  h.resolved.provider = {
    ...h.resolved.provider,
    bringDownObserved: (observation: ServiceRuntimeInfo, containers: ContainerDisposition) =>
      Effect.sync(() => {
        observedStops.push([String(observation.service), containers]);
        return { service: observation.service, containerId: "legacy-container", action: "stopped" as const };
      }),
    bringDown: (_target, options) =>
      Effect.sync(() => {
        bringDowns.push(options);
        return {
          kind: "stopped" as const,
          containers: Object.values(plan.services).map((service) => ({
            service: service.name,
            action: "stopped" as const,
          })),
        };
      }),
  };
  // When the whole global app is stopped.
  const receipt = await Effect.runPromise(
    stopGlobalResources(h.resolved).pipe(
      Effect.provideService(RuntimeProviderRegistry, makeTestRuntimeProviderRegistry()),
    ),
  );
  // Then the planful stop keeps containers, and only the running unplanned container is stopped too.
  expect(bringDowns).toEqual([{ containers: "stop" }]);
  expect(observedStops).toEqual([["legacy", "stop"]]);
  expect(receipt.services).toEqual(["mail", "database", "sibling", "legacy"]);
  expect(receipt.containers).toContainEqual({
    service: ServiceName.make("legacy"),
    containerId: "legacy-container",
    action: "stopped",
  });
});
