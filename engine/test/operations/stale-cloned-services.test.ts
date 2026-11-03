import { expect, test } from "bun:test";
import { Effect } from "effect";

import { type AppPlan, ServiceName } from "@lando/sdk/schema";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { CLONED_SERVICE_PROVENANCE_KEY } from "../../src/planner/cloned-services.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const sidecarName = ServiceName.make("web-schedule");
const sidecar: typeof web = {
  ...web,
  name: sidecarName,
  primary: false,
  provenance: { [CLONED_SERVICE_PROVENANCE_KEY]: { feature: "schedule.compile", from: "web" } },
};

const appliedWithClone: AppPlan = {
  ...plan,
  services: { [web.name]: web, [sidecarName]: sidecar },
};

const desiredWithoutClone: AppPlan = {
  ...plan,
  services: { [web.name]: web },
};

test("start stops leftover cloned services before apply", async () => {
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desiredWithoutClone,
    resolveAppliedPlan: () => Effect.succeed(appliedWithClone),
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
    resolveAppliedPlan: () => Effect.succeed(appliedWithClone),
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
  const applied: AppPlan = { ...plan, services: { [web.name]: web, [db.name]: db } };
  const desired: AppPlan = { ...plan, services: { [web.name]: web } };
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    resolveAppliedPlan: () => Effect.succeed(applied),
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
