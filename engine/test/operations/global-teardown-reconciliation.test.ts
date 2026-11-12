import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGlobalReconciliation,
  recordGlobalReconciliation,
} from "@lando/engine/global-app/reconciliation";
import { ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { Effect } from "effect";
import { globalDestroy } from "../../src/operations/global-destroy.ts";
import { globalStop } from "../../src/operations/global-stop.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";

const pending = [
  { phase: "evidence" as const, services: ["ssh-agent"], message: "Observe resources." },
  { phase: "containers" as const, services: ["ssh-agent"], message: "Remove resources." },
  { phase: "routes" as const, services: ["ssh-agent"], message: "Withdraw routes." },
  { phase: "generation" as const, services: [], message: "Regenerate configuration." },
] as const;

for (const command of ["stop", "destroy"] as const) {
  for (const mode of ["complete", "idle", "route-failure", "absent", "scoped"] as const) {
    test(`${command} clears only proven whole-app resource cleanup (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "global-teardown-reconciliation-"));
      try {
        const appRoot = AbsolutePath.make(join(root, "global"));
        const harness = await globalTeardownHarness(root, {
          ...(mode === "absent" ? {} : { plan: globalPlanAt(appRoot) }),
          routeFailure: mode === "route-failure",
          ...(mode === "idle" ? { status: Effect.succeed({ state: "idle" as const }) } : {}),
        });
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* recordGlobalReconciliation({
              revision: 3,
              operation: "disable",
              contributions: ["ssh-agent"],
              servicesRemoved: [],
              pending,
            });
            const outcome =
              command === "stop"
                ? yield* globalStop(mode === "scoped" ? { services: ["ssh-agent"] } : {}).pipe(Effect.result)
                : yield* globalDestroy({
                    yes: true,
                    ...(mode === "scoped" ? { providerId: ProviderId.make("lando") } : {}),
                  }).pipe(Effect.result);
            return { outcome, receipt: yield* readGlobalReconciliation() };
          }).pipe(Effect.provide(harness.layer)),
        );
        expect(result.outcome._tag).toBe(mode === "route-failure" ? "Failure" : "Success");
        expect(result.receipt.revision).toBe(3);
        expect(result.receipt.pending).toEqual(
          mode === "complete" || (mode === "idle" && command === "destroy")
            ? [pending[3]]
            : mode === "absent" || mode === "idle"
              ? pending.filter((entry) => entry.phase !== "routes")
              : pending,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const command of ["stop", "destroy"] as const) {
  for (const mode of ["complete", "idle", "absent"] as const) {
    test(`${command} without a selectable router succeeds and keeps every obligation pending (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "global-teardown-unavailable-router-"));
      try {
        // Given: recorded obligations and a router that cannot be selected.
        const harness = await globalTeardownHarness(root, {
          ...(mode === "absent" ? {} : { plan: globalPlanAt(AbsolutePath.make(join(root, "global"))) }),
          ...(mode === "idle" ? { status: Effect.succeed({ state: "idle" as const }) } : {}),
        });
        const router = makeUnavailableRouter(
          new ProxyError({
            message: "Router service missing is not installed.",
            proxyId: "missing",
            remediation:
              "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
          }),
        );

        // When
        const receipt = await Effect.runPromise(
          Effect.gen(function* () {
            yield* recordGlobalReconciliation({
              revision: 3,
              operation: "disable",
              contributions: ["ssh-agent"],
              servicesRemoved: [],
              pending,
            });
            yield* command === "stop" ? globalStop() : globalDestroy({ yes: true });
            return yield* readGlobalReconciliation();
          }).pipe(Effect.provideService(RouterService, router), Effect.provide(harness.layer)),
        );

        // Then: one skipped withdrawal is reported once and is not proof of route cleanup.
        expect(harness.calls).not.toContain("removeRoutes");
        expect(harness.calls.filter((call) => call === "message.warn")).toEqual(["message.warn"]);
        expect(receipt.pending).toEqual(pending);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("idle global stop withdraws routes once and records route cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "global-teardown-idle-withdrawal-"));
  try {
    // Given: an applied global app on an idle runtime and recorded obligations.
    const harness = await globalTeardownHarness(root, {
      plan: globalPlanAt(AbsolutePath.make(join(root, "global"))),
      status: Effect.succeed({ state: "idle" as const }),
    });

    // When
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordGlobalReconciliation({
          revision: 3,
          operation: "disable",
          contributions: ["ssh-agent"],
          servicesRemoved: [],
          pending,
        });
        yield* globalStop();
        return yield* readGlobalReconciliation();
      }).pipe(Effect.provide(harness.layer)),
    );

    // Then: the installed router is asked once and that withdrawal proves route cleanup.
    expect(harness.calls.filter((call) => call === "removeRoutes")).toEqual(["removeRoutes"]);
    expect(receipt.pending).toEqual(pending.filter((entry) => entry.phase !== "routes"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
