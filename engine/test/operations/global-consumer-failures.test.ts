import { expect, test } from "bun:test";
import { failureOutcomeFromCause, mergeFailure } from "@lando/sdk/command-result";
import { ServiceStartError } from "@lando/sdk/errors";
import { Cause, Effect, Exit } from "effect";
import { withGlobalConsumerAdmission } from "../../src/operations/global-consumer-admission.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const consumerPlan = { ...plan, requires: { globalServices: ["test"] } };

test("admitted consumer bodies preserve primary and secondary error roles", async () => {
  const harness = makeHarness({ plannedApp: consumerPlan });
  const primary = new ServiceStartError({
    service: "web",
    providerId: "lando",
    operation: "apply",
    message: "primary",
    remediation: "Repair primary.",
  });
  const secondary = new ServiceStartError({
    service: "web",
    providerId: "lando",
    operation: "apply",
    message: "peer",
    remediation: "Repair peer.",
  });
  const outcome = await Effect.runPromiseExit(
    withGlobalConsumerAdmission(
      { plan: consumerPlan },
      Effect.failCause(mergeFailure(Cause.fail(primary), Cause.fail(secondary), "peer")),
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(outcome)).toBe(true);
  if (Exit.isFailure(outcome)) {
    const failure = failureOutcomeFromCause(outcome.cause);
    expect(failure.error).toBe(primary);
    expect(failure.additionalErrors).toEqual([{ role: "peer", error: secondary }]);
  }
  expect(
    await Effect.runPromise(
      withGlobalConsumerAdmission({ plan: consumerPlan }, Effect.succeed("released")).pipe(
        Effect.provide(harness.layer),
      ),
    ),
  ).toBe("released");
});

test("admitted consumer bodies preserve defects and release activation ownership", async () => {
  const harness = makeHarness({ plannedApp: consumerPlan });
  const defect = new Error("consumer defect");
  const outcome = await Effect.runPromiseExit(
    withGlobalConsumerAdmission({ plan: consumerPlan }, Effect.die(defect)).pipe(
      Effect.provide(harness.layer),
    ),
  );
  expect(Exit.isFailure(outcome)).toBe(true);
  if (Exit.isFailure(outcome)) {
    const defects = outcome.cause.reasons.filter(Cause.isDieReason);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.defect).toBe(defect);
  }
  expect(
    await Effect.runPromise(
      withGlobalConsumerAdmission({ plan: consumerPlan }, Effect.succeed("released")).pipe(
        Effect.provide(harness.layer),
      ),
    ),
  ).toBe("released");
});
