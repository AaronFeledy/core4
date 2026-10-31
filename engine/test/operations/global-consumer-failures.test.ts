import { expect, test } from "bun:test";
import { failureOutcomeFromCause, mergeFailure } from "@lando/sdk/command-result";
import { GlobalAppError, ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { withGlobalConsumerAdmission } from "../../src/operations/global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "../../src/operations/global-consumer-lease.ts";
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

test("final global ensure preserves mapped primary and secondary admission errors", async () => {
  const harness = makeHarness({ plannedApp: consumerPlan });
  const global = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
  const primary = new GlobalAppError({ message: "ensure primary", remediation: "Repair primary." });
  const secondary = new GlobalAppError({ message: "ensure rollback", remediation: "Repair rollback." });
  let entered = false;
  const outcome = await Effect.runPromiseExit(
    withGlobalConsumerAdmission(
      { plan: consumerPlan },
      Effect.sync(() => {
        entered = true;
      }),
    ).pipe(
      Effect.provideService(GlobalAppService, {
        ...global,
        ensureRoot: Effect.failCause(mergeFailure(Cause.fail(primary), Cause.fail(secondary), "rollback")),
      }),
      Effect.provide(harness.layer),
    ),
  );
  expect(entered).toBe(false);
  expect(Exit.isFailure(outcome)).toBe(true);
  if (Exit.isFailure(outcome))
    expect(failureOutcomeFromCause(outcome.cause)).toMatchObject({
      error: { _tag: "GlobalAutoStartError", cause: primary },
      additionalErrors: [{ role: "rollback", error: { _tag: "GlobalAutoStartError", cause: secondary } }],
    });
});

test("post-admission verification preserves mapped provider error roles", async () => {
  const harness = makeHarness({ plannedApp: consumerPlan });
  const registry = await Effect.runPromise(RuntimeProviderRegistry.pipe(Effect.provide(harness.layer)));
  const primary = new ProviderUnavailableError({
    providerId: "lando",
    operation: "select",
    message: "provider primary",
    remediation: "Repair primary.",
  });
  const secondary = new ProviderUnavailableError({
    providerId: "lando",
    operation: "select",
    message: "provider peer",
    remediation: "Repair peer.",
  });
  let reject = false;
  const guarded = RuntimeProviderRegistry.of({
    ...registry,
    select: (target) =>
      reject
        ? Effect.failCause(mergeFailure(Cause.fail(primary), Cause.fail(secondary), "peer"))
        : registry.select(target),
  });
  const outcome = await Effect.runPromiseExit(
    withGlobalConsumerAdmission(
      { plan: consumerPlan },
      Effect.sync(() => {
        reject = true;
      }).pipe(Effect.andThen(verifyGlobalConsumerAdmission)),
    ).pipe(Effect.provideService(RuntimeProviderRegistry, guarded), Effect.provide(harness.layer)),
  );
  expect(reject).toBe(true);
  expect(Exit.isFailure(outcome)).toBe(true);
  if (Exit.isFailure(outcome))
    expect(failureOutcomeFromCause(outcome.cause)).toMatchObject({
      error: { _tag: "GlobalAutoStartError", cause: primary },
      additionalErrors: [{ role: "peer", error: { _tag: "GlobalAutoStartError", cause: secondary } }],
    });
});
