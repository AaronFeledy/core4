import { AppId, type AppPlan, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

export const current = {
  ...plan,
  identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
} satisfies AppPlan;
export const stale = { ...current, id: AppId.make("previous"), name: "previous", slug: "previous" };
export const target = {
  plan: current,
  root: current.root,
  app: { kind: "user" as const, id: current.id, root: current.root },
};

export const fixture = (root = current.root) => {
  const applied = [stale, current].map((plan) => ({
    ...plan,
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  }));
  const containers = new Set(applied.map((plan) => plan.id));
  const volumes = new Set(applied.map((plan) => plan.id));
  const caches = new Set(applied.map((plan) => plan.id));
  const providers = [{ ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.sync(() => [...applied]) }];
  const harness = makeHarness({
    plannedApp: { ...current, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } },
    appliedPlans: applied,
    resolveAppliedPlan: (root, app) => resolveAppliedPlanEvidence(root, providers, app),
    resolveTeardownEvidence: (root, app) => resolveTeardownEvidence(root, providers, app),
    onDestroy: (ref, options) => {
      containers.delete(ref.app);
      if (options?.volumes === true) volumes.delete(ref.app);
      if (options?.purgeCaches === true) caches.delete(ref.app);
      if (options?.removeState === true) {
        const index = applied.findIndex((plan) => plan.id === ref.app);
        if (index >= 0) applied.splice(index, 1);
      }
    },
  });
  return { ...harness, applied, containers, volumes, caches };
};
