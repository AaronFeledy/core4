import { expect, test } from "bun:test";
import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import { type AppPlan, ProviderId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { removeStaleClonedServices } from "../../src/operations/stale-cloned-services.ts";
import { CLONED_SERVICE_PROVENANCE_KEY } from "../../src/planner/cloned-services.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const identity = { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) };
const withIdentity = (value: AppPlan): AppPlan => ({ ...value, identity });

const sidecarName = ServiceName.make("web-schedule");
const sidecar: typeof web = {
  ...web,
  name: sidecarName,
  primary: false,
  provenance: { [CLONED_SERVICE_PROVENANCE_KEY]: { feature: "schedule.compile", from: "web" } },
};

const appliedWithClone = withIdentity({
  ...plan,
  services: { [web.name]: web, [sidecarName]: sidecar },
});

const desiredWithoutClone = withIdentity({
  ...plan,
  services: { [web.name]: web },
});

const sidecarObservation = (app: AppPlan["id"]): ServiceRuntimeInfo => ({
  app,
  service: sidecarName,
  providerId: plan.provider,
  status: "exited",
  containerId: "stale-web-schedule",
  publications: { status: "unknown" },
});

const orphanRefusal = () =>
  Effect.fail(
    new AppResolveError({
      message: "Runtime resources remain without matching applied app state.",
      reason: "mismatch",
      detail: "provider-resources",
      remediation:
        "Restore the matching applied state or remove the orphaned provider resources before retrying teardown.",
    }),
  );

const leftoverCleanupHarness = (
  calls: string[],
  desired: AppPlan,
  appliedPlans: ReadonlyArray<AppPlan>,
  listRows: ReadonlyArray<ServiceRuntimeInfo>,
) =>
  makeHarness({
    plannedApp: desired,
    appliedPlans,
    onStop: (target) => {
      calls.push(`stop:${target.service}`);
    },
    onApply: () => {
      calls.push("apply");
    },
    providerOverrides: {
      list: () => Effect.succeed(listRows),
      removeObservedService: (observed) =>
        Effect.sync(() => {
          calls.push(`remove:${observed.service}`);
          return { kind: "removed" as const };
        }),
    },
  });

test("start removes leftover cloned services before apply", async () => {
  const calls: string[] = [];
  const harness = leftoverCleanupHarness(
    calls,
    desiredWithoutClone,
    [appliedWithClone],
    [sidecarObservation(appliedWithClone.id)],
  );
  await runStart(harness, desiredWithoutClone);
  expect(calls).toEqual(["remove:web-schedule", "apply"]);
});

test("rebuild removes leftover cloned services before apply", async () => {
  const calls: string[] = [];
  const harness = leftoverCleanupHarness(
    calls,
    desiredWithoutClone,
    [appliedWithClone],
    [sidecarObservation(appliedWithClone.id)],
  );
  await Effect.runPromise(
    rebuildApp(
      {},
      {
        plan: desiredWithoutClone,
        root: desiredWithoutClone.root,
        app: { kind: "user", id: desiredWithoutClone.id, root: desiredWithoutClone.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(calls).toContain("remove:web-schedule");
  expect(calls).toContain("apply");
  expect(calls.indexOf("remove:web-schedule")).toBeLessThan(calls.indexOf("apply"));
});

test("start leaves authored services that left the plan running", async () => {
  const db = { ...web, name: ServiceName.make("db"), primary: false };
  const applied = withIdentity({ ...plan, services: { [web.name]: web, [db.name]: db } });
  const desired = withIdentity({ ...plan, services: { [web.name]: web } });
  const calls: string[] = [];
  const harness = leftoverCleanupHarness(
    calls,
    desired,
    [applied],
    [
      {
        app: applied.id,
        service: db.name,
        providerId: plan.provider,
        status: "running",
        containerId: "authored-db",
        publications: { status: "unknown" },
      },
    ],
  );
  await runStart(harness, desired);
  expect(calls).toEqual(["apply"]);
});

test("start retries after a failed apply without resolving orphan runtime resources", async () => {
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desiredWithoutClone,
    appliedPlans: [],
    resolveAppliedPlan: orphanRefusal,
    onStop: (target) => {
      calls.push(`stop:${target.service}`);
    },
    onApply: () => {
      calls.push("apply");
    },
    providerOverrides: {
      removeObservedService: (observed) =>
        Effect.sync(() => {
          calls.push(`remove:${observed.service}`);
          return { kind: "removed" as const };
        }),
    },
  });
  await runStart(harness, desiredWithoutClone);
  expect(calls).toEqual(["apply"]);
});

test("skips leftover clone cleanup when applied plans are for another provider", async () => {
  const calls: string[] = [];
  const other = withIdentity({ ...appliedWithClone, provider: ProviderId.make("docker") });
  const harness = leftoverCleanupHarness(calls, desiredWithoutClone, [other], [sidecarObservation(other.id)]);
  await Effect.runPromise(removeStaleClonedServices(desiredWithoutClone).pipe(Effect.provide(harness.layer)));
  expect(calls).toEqual([]);
});
