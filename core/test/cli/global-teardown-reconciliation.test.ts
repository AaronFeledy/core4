import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGlobalReconciliation,
  recordGlobalReconciliation,
} from "@lando/engine/global-app/reconciliation";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { globalDestroy } from "../../src/cli/commands/meta/global-destroy.ts";
import { globalStop } from "../../src/cli/commands/meta/global-stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../_support/global-teardown-harness.ts";

const pending = [
  { phase: "evidence" as const, services: ["ssh-agent"], message: "Observe resources." },
  { phase: "containers" as const, services: ["ssh-agent"], message: "Remove resources." },
  { phase: "routes" as const, services: ["ssh-agent"], message: "Withdraw routes." },
  { phase: "generation" as const, services: [], message: "Regenerate configuration." },
] as const;

for (const command of ["stop", "destroy"] as const) {
  for (const mode of ["complete", "route-failure", "absent", "scoped"] as const) {
    test(`${command} clears only proven whole-app resource cleanup (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "global-teardown-reconciliation-"));
      try {
        const appRoot = AbsolutePath.make(join(root, "global"));
        const harness = await globalTeardownHarness(root, {
          ...(mode === "absent" ? {} : { plan: globalPlanAt(appRoot) }),
          routeFailure: mode === "route-failure",
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
          mode === "complete"
            ? [pending[3]]
            : mode === "absent"
              ? pending.filter((entry) => entry.phase !== "routes")
              : pending,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
