import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppId, type AppPlan, LoadScopedLandofile, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { openJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan } from "./start-progress-topology-support.ts";

const old: AppPlan = {
  ...plan,
  identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
  stores: [
    { name: "old-data", kind: "data", scope: "app" },
    { name: "shared-cache", kind: "cache", scope: "global" },
  ],
};
const desired: AppPlan = {
  ...old,
  identity: {
    ...old.identity,
    appRoot: old.root,
    ownerKey: appIdentityKey("owner", old.root),
    dataName: old.name,
  },
  id: AppId.make("renamed"),
  name: "renamed",
  slug: "renamed",
  stores: [
    { name: "new-data", kind: "data", scope: "app" },
    { name: "shared-cache", kind: "cache", scope: "global" },
  ],
};
const target = {
  app: { kind: "user" as const, id: desired.id, root: desired.root },
  root: desired.root,
  plan: desired,
  landofile: LoadScopedLandofile.make({
    stage: "load-scoped",
    document: { name: desired.name },
    pendingSites: [],
    context: { appRoot: desired.root, env: {} },
  }),
};

test("destroy --volumes after rename reaches old and new names through root ownership", async () => {
  const applied: AppPlan[] = [old];
  const data = new Map([[old.id, "old-data"]]);
  const ownership = {
    appRoot: old.root,
    ownerKey: appIdentityKey("owner", old.root),
    providerId: old.provider,
    appIds: [old.id, desired.id],
  };
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: applied,
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan: desired, ownership: [ownership] }),
    onDestroy: (ref, options) => {
      const index = applied.findIndex((plan) => plan.id === ref.app);
      if (options?.removeState === true && index >= 0) applied.splice(index, 1);
      if (options?.volumes === true) data.delete(ref.app);
    },
    onApply: (plan) => {
      applied.push(plan);
      data.set(plan.id, "new-data");
    },
    providerOverrides: {
      getStatus: Effect.succeed({ state: "running" as const }),
      cleanupOwnedResources: (_root, options) =>
        Effect.sync(() => {
          let removed = 0;
          if (options.volumes === true)
            for (const id of options.appIds ?? []) {
              if (data.delete(AppId.make(id))) removed++;
            }
          return { servicesRemoved: [], networksRemoved: 0, volumesRemoved: removed };
        }),
    },
  });
  try {
    await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
    expect([...data.values()]).toEqual(["old-data", "new-data"]);
    const result = await Effect.runPromise(
      destroyApp({ volumes: true }, target).pipe(Effect.provide(harness.layer)),
    );
    expect(result.volumesRemoved).toBe(true);
    expect([...data.values()]).toEqual([]);
    expect(applied).toEqual([]);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test.each(
  [startApp, restartApp, rebuildApp].flatMap((operation) =>
    [false, true].map((legacyDouble) => ({ operation, legacyDouble })),
  ),
)(
  "$operation replaces the old realization and retains its data (legacy double: $legacyDouble)",
  async ({ operation, legacyDouble }) => {
    const applied: AppPlan[] = legacyDouble ? [old, desired] : [old];
    const containers = new Set(applied.map((plan) => plan.id));
    const volumes = new Set(["old-data"]);
    let retired = 0;
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: applied,
      resolveAppliedPlan: () => Effect.sync(() => applied[0]),
      onRemoveRoutes: () => {
        expect(retired).toBe(1);
      },
      onDestroy: (ref, options) => {
        if (ref.app === old.id) {
          expect(ref.plan).toEqual(old);
          expect(options).toMatchObject({ volumes: false, purgeCaches: false, removeState: true });
          retired++;
        }
        containers.delete(ref.app);
        const index = applied.findIndex((plan) => plan.id === ref.app);
        if (index >= 0 && options?.removeState === true) applied.splice(index, 1);
        if (options?.volumes === true) volumes.clear();
      },
      onApply: (plan) => {
        containers.add(plan.id);
        applied.splice(0, applied.length, plan);
        volumes.add("new-data");
      },
    });
    try {
      const result = await Effect.runPromise(operation({}, target).pipe(Effect.provide(harness.layer)));
      expect(result.app).toBe("renamed");
      expect(applied.map((plan) => plan.id)).toEqual([desired.id]);
      expect([...containers]).toEqual([desired.id]);
      expect([...volumes]).toEqual(["old-data", "new-data"]);
      expect(retired).toBe(1);
      // The warning names both apps and the kept volumes; its wording is not pinned.
      const warnings = byTag(harness.events, "message.warn").filter(
        (event) => event.body.includes(old.name) && event.body.includes("renamed"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.body).not.toContain("old-data");
      expect(warnings[0]?.body).not.toContain("shared-cache");
      expect(byTag(harness.events, "pre-destroy")).toEqual([]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each([restartApp, rebuildApp])(
  "%s refuses selected services before any rename mutation",
  async (operation) => {
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [old],
      onDestroy: () => mutations++,
      onStop: () => mutations++,
      onApply: () => mutations++,
      onBuildApp: () => mutations++,
    });
    try {
      const result = await Effect.runPromise(
        operation({ services: [ServiceName.make("web")] }, target).pipe(
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AppResolveError",
          reason: "mismatch",
          detail: "applied-state",
        },
      });
      expect(mutations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each(
  [startApp, restartApp, rebuildApp].flatMap((operation) =>
    [false, true].map((knownName) => ({ operation, knownName })),
  ),
)(
  "%s refuses rename with an unfinished root journal and names its recorded app",
  async ({ operation, knownName }) => {
    let mutations = 0;
    const previous = { ...old, id: AppId.make("my-app"), name: "My App", slug: "my-app" };
    const recordedId = knownName ? previous.id : "missing-original";
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [previous],
      onDestroy: () => mutations++,
      onApply: () => mutations++,
      onStop: () => mutations++,
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bucket = yield* openJournal(target.app);
          yield* bucket.update(() => ({
            attemptId: "interrupted",
            appId: recordedId,
            appRoot: old.root,
            providerId: old.provider,
            engineId: "mutagen",
            mountPlanDigest: "old",
            phase: "preparing",
            targets: [],
            sessions: [],
          }));
        }).pipe(Effect.provide(harness.layer)),
      );
      const result = await Effect.runPromise(
        operation({}, target).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "FileSyncStartError",
          engineId: "mutagen",
          cause: { appId: recordedId, appRoot: old.root, ...(knownName ? { appName: "My App" } : {}) },
        },
      });
      expect(mutations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
