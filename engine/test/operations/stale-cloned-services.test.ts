import { expect, test } from "bun:test";
import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName, appIdentityKey } from "@lando/sdk/schema";

import { rebuildApp } from "../../src/operations/rebuild.ts";
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

test("start stops leftover cloned services before apply", async () => {
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desiredWithoutClone,
    appliedPlans: [appliedWithClone],
    onStop: (target) => {
      calls.push(`stop:${target.service}`);
    },
    onApply: () => {
      calls.push("apply");
    },
  });
  await runStart(harness, desiredWithoutClone);
  expect(calls).toEqual(["stop:web-schedule", "apply"]);
});

test("rebuild stops leftover cloned services before apply", async () => {
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desiredWithoutClone,
    appliedPlans: [appliedWithClone],
    onStop: (target) => {
      calls.push(`stop:${target.service}`);
    },
    onApply: () => {
      calls.push("apply");
    },
  });
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
  expect(calls).toContain("stop:web-schedule");
  expect(calls).toContain("apply");
  expect(calls.indexOf("stop:web-schedule")).toBeLessThan(calls.indexOf("apply"));
});

test("start leaves authored services that left the plan running", async () => {
  const db = { ...web, name: ServiceName.make("db"), primary: false };
  const applied = withIdentity({ ...plan, services: { [web.name]: web, [db.name]: db } });
  const desired = withIdentity({ ...plan, services: { [web.name]: web } });
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [applied],
    onStop: (target) => {
      calls.push(`stop:${target.service}`);
    },
    onApply: () => {
      calls.push("apply");
    },
  });
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
  });
  await runStart(harness, desiredWithoutClone);
  expect(calls).toEqual(["apply"]);
});
