import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { appIdentityKey } from "@lando/sdk/schema";
import { Effect, Exit, type Layer } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { registryLayer } from "../providers/fixtures/error-registry.ts";
import { providerFaults } from "./provider-fault-fixtures.ts";
import { appliedPlanRecord, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const applied = appliedPlanRecord({
  ...plan,
  identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
});
const target = {
  plan: applied,
  root: applied.root,
  app: { kind: "user" as const, id: applied.id, root: applied.root },
};

const operations: readonly {
  readonly name: string;
  readonly member: "apply" | "destroy" | "stop";
  readonly run: () => Effect.Effect<unknown, unknown, Layer.Success<ReturnType<typeof makeHarness>["layer"]>>;
}[] = [
  { name: "start", member: "apply", run: () => startAppForTarget({}, target) },
  { name: "stop", member: "destroy", run: () => stopAppForTarget({}, target) },
  { name: "destroy", member: "destroy", run: () => destroyAppForTarget({}, target) },
  { name: "rebuild", member: "destroy", run: () => rebuildApp({}, target) },
  { name: "restart", member: "destroy", run: () => restartApp({}, target) },
  {
    name: "rebuild selected",
    member: "stop",
    run: () => rebuildApp({ services: [web.name] }, target),
  },
  {
    name: "restart selected",
    member: "stop",
    run: () => restartApp({ services: [web.name] }, target),
  },
];

for (const operation of operations) {
  for (const [tag, fault] of Object.entries(providerFaults)) {
    test(`${operation.name} preserves ${tag} from provider.${operation.member} as primary`, async () => {
      // Given an ownership-matched applied record and the real registry's output policy.
      const harness = makeHarness({ plannedApp: applied });
      const baseline = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const calls: string[] = [];
      const fail = () =>
        Effect.sync(() => calls.push(operation.member)).pipe(Effect.andThen(Effect.fail(fault)));
      const provider = { ...baseline, [operation.member]: fail };
      const registry = registryLayer(provider, {
        contribution: { appliedPlans: () => Effect.succeed([applied]) },
      });
      try {
        // When the first mutating provider member fails, through the operation entry point.
        const exit = await Effect.runPromiseExit(
          operation.run().pipe(Effect.provide(registry), Effect.provide(harness.layer)),
        );
        // Then neither registry redaction, compensation, nor task cleanup relabels it.
        expect(calls).toEqual([operation.member]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const outcome = failureOutcomeFromCause(exit.cause);
          expect(outcome.error).toMatchObject({
            _tag: tag,
            message: fault.message,
            remediation: fault.remediation,
          });
          expect(outcome.additionalErrors).toEqual([]);
        }
      } finally {
        rmSync(harness.userDataRoot, { recursive: true, force: true });
      }
    });
  }
}
