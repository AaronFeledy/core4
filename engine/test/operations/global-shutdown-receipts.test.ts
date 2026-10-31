import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, ProviderId, ServiceName, type ServiceShutdownObservation } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { GlobalDestroyResultSchema, globalDestroy } from "../../src/operations/global-destroy.ts";
import { GlobalStopResultSchema, globalStop } from "../../src/operations/global-stop.ts";
import { removeGlobalResources } from "../../src/operations/global-teardown-resources.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
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

for (const command of ["stop", "destroy"] as const) {
  for (const kind of ["destroyed", "no-op", "unobserved", "absent"] as const) {
    test(`${command} entrypoint encodes ${kind} shutdown receipts without inventing facts`, async () => {
      // Given a provider receipt with exact identity, OOM and inspect diagnostic evidence.
      const root = await mkdtemp(join(tmpdir(), "global-shutdown-receipts-"));
      try {
        const observations: readonly ServiceShutdownObservation[] = [
          { ...observation, service: ServiceName.make("ssh-agent"), exitCode: 137, oomKilled: true },
          {
            appId: id,
            providerId: observation.providerId,
            service: ServiceName.make("ssh-agent"),
            containerId: "global-agent-old",
            status: "unknown",
            reason: "inspect-failed",
            diagnostic: {
              _tag: "ProviderRequestError",
              message: "inspect timed out",
              remediation: "Retry inspect.",
            },
          },
        ];
        const harness = await globalTeardownHarness(root, {
          ...(kind === "absent" ? {} : { plan: globalPlanAt(AbsolutePath.make(join(root, "global"))) }),
          destroyOutcome:
            kind === "no-op"
              ? { kind, reason: "no-applied-plan", shutdownObservations: observations }
              : {
                  kind: "destroyed",
                  ...(kind === "unobserved" ? {} : { shutdownObservations: observations }),
                },
        });
        // When the engine operation runs and its public command schema encodes the result.
        const encoded =
          command === "stop"
            ? Schema.encodeSync(GlobalStopResultSchema)(
                await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer))),
              )
            : Schema.encodeSync(GlobalDestroyResultSchema)(
                await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer))),
              );
        // Then all contributed facts survive, while unsupported or absent observations stay omitted.
        if (kind === "unobserved" || kind === "absent") {
          expect(encoded).not.toHaveProperty("shutdownObservations");
        } else {
          expect(encoded.shutdownObservations).toEqual(observations);
          expect(encoded.outcome).toBe(
            kind === "no-op" ? "unchanged" : command === "stop" ? "stopped" : "destroyed",
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
