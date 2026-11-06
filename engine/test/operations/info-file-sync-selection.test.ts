import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type AppPlan, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { infoApp } from "../../src/operations/info.ts";
import { session } from "./accelerated-start-recovery-support.ts";
import { appMount, withAppMount } from "./info-storage-fixture.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const names = ["frontend", "database", "api"] as const;
const selected = [ServiceName.make("api"), ServiceName.make("frontend")];
const policyPlan = (accelerated: boolean, changedService?: string): AppPlan => ({
  ...plan,
  identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
  services: Object.fromEntries(
    names.map((name) => [
      name,
      withAppMount(
        { ...web, name: ServiceName.make(name) },
        {
          ...appMount,
          source: plan.root,
          realization: accelerated ? "accelerated" : "passthrough",
          mountKey: "app-mount",
          includes: [],
          excludes: name === changedService ? ["cache"] : [],
        },
      ),
    ]),
  ),
  fileSync: accelerated
    ? names.map((name) => ({
        engineId: "mutagen",
        session: {
          ...session,
          service: ServiceName.make(name),
          target: { ...session.target, name: `${plan.name}-${name}-app-mount` },
          excludes: name === changedService ? ["cache", ".git"] : [".git"],
        },
      }))
    : [],
  fileSyncPolicy: {
    ...(accelerated ? { engineId: "mutagen" } : {}),
    reason: accelerated ? "explicit-engine" : "native-provider",
    services: Object.fromEntries(
      names.map((name) => [
        name,
        {
          mode: accelerated ? "accelerated" : "ordinary",
          reason: accelerated ? "explicit-engine" : "native-provider",
        },
      ]),
    ),
  },
});

const runSelectedInfo = async (
  desired: AppPlan,
  applied: AppPlan | undefined,
  services: readonly ServiceName[] = selected,
) => {
  const inspected: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: applied === undefined ? [] : [applied],
    resolveAppliedPlan: () => Effect.succeed(applied),
    inspect: ({ service }) =>
      Effect.sync(() => {
        inspected.push(service);
        return {
          app: desired.id,
          service,
          providerId: desired.provider,
          status: "running",
          publications: { status: "present" as const, bindings: [] },
        };
      }),
  });
  try {
    const info = await Effect.runPromise(
      withResolvedCwd(plan.root, infoApp({ services })).pipe(Effect.provide(harness.layer)),
    );
    return { info, inspected };
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
};

for (const accelerated of [false, true]) {
  for (const hasApplied of [false, true]) {
    test(`selected info limits ${accelerated ? "accelerated" : "ordinary"} policies with applied=${hasApplied}`, async () => {
      // Given complete three-service policy evidence and reverse-order service flags.
      const desired = policyPlan(accelerated);
      // When the public operation selects two services.
      const { info, inspected } = await runSelectedInfo(desired, hasApplied ? desired : undefined);
      // Then all service rows use plan order, without inspecting or leaking the database.
      expect(info.services.map(({ service }) => service)).toEqual(["frontend", "api"]);
      expect(inspected).toEqual(["frontend", "api"]);
      const expected = {
        mode: accelerated ? "accelerated" : "ordinary",
        reason: accelerated ? "explicit-engine" : "native-provider",
        services: ["frontend", "api"].map((service) => ({
          service,
          mode: accelerated ? "accelerated" : "ordinary",
          reason: accelerated ? "explicit-engine" : "native-provider",
        })),
      };
      expect(info.fileSync?.planned).toMatchObject(expected);
      if (hasApplied) expect(info.fileSync?.applied).toMatchObject(expected);
      else expect(info.fileSync).not.toHaveProperty("applied");
      expect(JSON.stringify(info)).not.toContain('"service":"database"');
      expect(info.fileSync?.pendingChange).toBe(false);
    });
  }
}

test.each([
  { changed: "database", pending: false },
  { changed: "api", pending: true },
])("selected info scopes service policy changes in $changed", async ({ changed, pending }) => {
  // Given a valid filter change on either a selected or an unselected service.
  const applied = policyPlan(true);
  const desired = policyPlan(true, changed);
  // When inspecting the selected view.
  const { info } = await runSelectedInfo(desired, applied);
  // Then pendingChange compares the displayed policies, not hidden service rows.
  expect(info.fileSync?.planned?.mode).toBe("accelerated");
  expect(info.fileSync?.pendingChange).toBe(pending);
});

test("selected info retains app-level engine changes", async () => {
  // Given matching service facts but a different verified engine in the desired plan.
  const applied = policyPlan(true);
  const desired: AppPlan = {
    ...applied,
    fileSync: applied.fileSync.map((entry) => ({ ...entry, engineId: "replacement" })),
    fileSyncPolicy: {
      ...applied.fileSyncPolicy,
      engineId: "replacement",
      reason: "explicit-engine",
      services: applied.fileSyncPolicy?.services ?? {},
    },
  };
  // When inspecting selected services.
  const { info } = await runSelectedInfo(desired, applied);
  // Then app-level policy evidence still participates in the comparison.
  expect(info.fileSync?.planned?.engineId).toBe("replacement");
  expect(info.fileSync?.applied?.engineId).toBe("mutagen");
  expect(info.fileSync?.pendingChange).toBe(true);
});

test("unscoped info retains desired-only services in the policy comparison", async () => {
  // Given a new service present only in desired policy.
  const applied = policyPlan(false);
  const desired: AppPlan = {
    ...applied,
    services: {
      ...applied.services,
      [ServiceName.make("worker")]: { ...web, name: ServiceName.make("worker") },
    },
    fileSyncPolicy: {
      reason: "native-provider",
      services: {
        ...applied.fileSyncPolicy?.services,
        worker: { mode: "absent", reason: "absent-app-mount" },
      },
    },
  };
  // When no service filter is supplied.
  const { info } = await runSelectedInfo(desired, applied, []);
  // Then the app-wide desired addition remains visible and pending.
  expect(info.fileSync?.planned?.services.map(({ service }) => service)).toEqual([...names, "worker"]);
  expect(info.fileSync?.pendingChange).toBe(true);
});

for (const malformedSide of ["planned", "applied"] as const) {
  test(`selected info retains unknown ${malformedSide} evidence from an unselected service`, async () => {
    // Given missing session coverage outside the selection, and a different valid policy.
    const full = policyPlan(true);
    const malformed = {
      ...full,
      fileSync: full.fileSync.filter(({ session }) => session.service !== "database"),
    };
    const ordinary = policyPlan(false);
    // When selecting services whose own session coverage is intact.
    const { info } = await runSelectedInfo(
      malformedSide === "planned" ? malformed : ordinary,
      malformedSide === "applied" ? malformed : ordinary,
    );
    // Then full-plan validity is not manufactured by hiding the broken service.
    expect(info.fileSync?.[malformedSide]).toMatchObject({
      mode: "unknown",
      reason: "unknown",
      services: [
        { service: "frontend", mode: "unknown" },
        { service: "api", mode: "unknown" },
      ],
    });
    expect(info.fileSync?.pendingChange).toBe(false);
  });
}
