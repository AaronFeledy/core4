import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServiceShutdownObservation } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { removeGlobalResources } from "../../src/operations/global-teardown-resources.ts";
import { harness as globalHarness, id, plan } from "./global-stop-selection-fixture.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const observation: ServiceShutdownObservation = {
  appId: id,
  providerId: ProviderId.make("lando"),
  service: ServiceName.make("mail"),
  containerId: "global-mail",
  status: "exited",
  exitCode: 143,
};

test.each(["destroyed", "no-op"] as const)(
  "whole global %s receipt preserves provider shutdown facts",
  async (kind) => {
    // Given
    const { resolved } = globalHarness();
    const harness = makeHarness();
    const provider = {
      ...resolved.provider,
      destroy: () =>
        Effect.succeed(
          kind === "destroyed"
            ? { kind, shutdownObservations: [observation] }
            : { kind, reason: "no-applied-plan" as const, shutdownObservations: [observation] },
        ),
    };
    // When
    const receipt = await Effect.runPromise(
      removeGlobalResources({ ...resolved, provider }, { volumes: false, removeState: true }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    // Then
    expect(receipt.shutdownObservations).toEqual([observation]);
    expect(receipt.changed).toBe(kind === "destroyed");
  },
);

test("whole global orphan teardown preserves attributed removal facts", async () => {
  // Given
  const { resolved } = globalHarness();
  const provider = {
    ...TestRuntimeProvider,
    removeObservedService: () =>
      Effect.succeed({ kind: "removed" as const, shutdownObservations: [observation] }),
  };
  const harness = makeHarness({
    selectProvider: () => Effect.succeed(provider),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
  });
  // When
  const receipt = await Effect.runPromise(
    removeGlobalResources(
      {
        ...resolved,
        provider,
        evidence: {
          kind: "orphans",
          groups: [
            {
              appId: id,
              providerId: plan.provider,
              volumes: [],
              services: [
                {
                  app: id,
                  providerId: plan.provider,
                  appRoot: plan.root,
                  service: ServiceName.make("mail"),
                  containerId: "global-mail",
                  status: "running",
                  publications: { status: "unknown" },
                },
              ],
            },
          ],
        },
      },
      { volumes: false, removeState: true },
    ).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(receipt.shutdownObservations).toEqual([observation]);
});

test("whole global legacy provider honestly omits unsupported observations", async () => {
  // Given
  const { resolved } = globalHarness();
  const harness = makeHarness();
  const provider = { ...resolved.provider, destroy: () => Effect.succeed({ kind: "destroyed" as const }) };
  // When
  const receipt = await Effect.runPromise(
    removeGlobalResources({ ...resolved, provider }, { volumes: false, removeState: true }).pipe(
      Effect.provide(harness.layer),
    ),
  );
  // Then
  expect(receipt).not.toHaveProperty("shutdownObservations");
});
