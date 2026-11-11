import { expect, test } from "bun:test";
import { ServiceNotFoundError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("scoped rebuild recreates a service whose container is already gone", async () => {
  // Given a planned service with no container, as after `lando stop`.
  let applied: AppPlan | undefined;
  const harness = makeHarness({
    plannedApp: plan,
    providerOverrides: {
      stop: (target) =>
        Effect.fail(
          new ServiceNotFoundError({
            providerId: String(plan.provider),
            operation: "stop",
            service: target.service,
            message: `Service ${target.service} was not found.`,
            remediation: "Add the missing service to the Landofile.",
          }),
        ),
    },
    onApply: (appliedPlan) =>
      Effect.sync(() => {
        applied = appliedPlan;
      }),
  });

  // When
  await Effect.runPromise(
    rebuildApp(
      { services: [ServiceName.make("web")] },
      { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
    ).pipe(Effect.provide(harness.layer)),
  );

  // Then the rebuild still builds and applies the service.
  expect(Object.keys(applied?.services ?? {})).toEqual([web.name]);
});
