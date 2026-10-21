import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AppResolveError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  ensureAppPlacement,
  observedAppPlan,
  resolveAppPlacement,
} from "../../src/providers/app-placement.ts";
import { HostProviderOverride } from "../../src/providers/host-provider.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const desired = { ...plan, provider: ProviderId.make("docker") };
const applied = {
  ...plan,
  provider: ProviderId.make("lando"),
  identity: { appRoot: plan.root, ownerKey: "owner" },
};
const app = { kind: "user" as const, id: desired.id, root: desired.root };
const target = { app, root: desired.root, plan: desired };

test("user start preserves a required global service placement failure at top level", async () => {
  const appliedPlans: AppPlan[] = [];
  let applies = 0;
  const plannedApp = { ...plan, requires: { globalServices: ["traefik"] } };
  const harness = makeHarness({
    plannedApp,
    appliedPlans,
    onApply: () => {
      applies += 1;
    },
  });
  const root = AbsolutePath.make(join(harness.userDataRoot, "global"));
  appliedPlans.push({
    ...applied,
    id: AppId.make("global"),
    root,
    identity: { appRoot: root, ownerKey: "global" },
  });
  try {
    const result = await Effect.runPromise(
      startApp({}, { plan: plannedApp, app, root: plannedApp.root }).pipe(
        Effect.provideService(
          GlobalAppService,
          GlobalAppService.of({
            id: "global",
            root: Effect.succeed(root),
            paths: Effect.succeed({
              root,
              distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
              userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
            }),
            ensureRoot: Effect.die("placement must precede materialization"),
            ensureUserLandofile: Effect.die("placement must precede materialization"),
            regenerateDist: () => Effect.die("placement must precede materialization"),
            ensureRunning: () => Effect.succeed([]),
          }),
        ),
        Effect.provide(harness.layer),
        Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "AppPlacementError",
        app: { kind: "global" },
        desiredProviderId: "docker",
        realizedProviderId: "lando",
      },
    });
    expect(applies).toBe(0);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

for (const operation of [startApp, rebuildApp, restartApp]) {
  test(`${operation.name} refuses another provider's applied app before apply or teardown`, async () => {
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [applied],
      onApply: () => {
        mutations += 1;
      },
      onDestroy: () => {
        mutations += 1;
      },
      onStop: () => {
        mutations += 1;
      },
    });
    try {
      const result = await Effect.runPromise(
        operation({}, target).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AppPlacementError",
          app,
          desiredProviderId: "docker",
          realizedProviderId: "lando",
        },
      });
      expect(mutations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}

test("observation reuses the applied plan instead of the newly selected provider", async () => {
  const harness = makeHarness({ plannedApp: desired, appliedPlans: [applied] });
  try {
    const result = await Effect.runPromise(observedAppPlan(desired).pipe(Effect.provide(harness.layer)));
    expect(result).toEqual(applied);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("ambiguous placement names provider-scoped confirmed destroy commands", async () => {
  const harness = makeHarness({ appliedPlans: [applied, { ...applied, provider: desired.provider }] });
  try {
    const error = await Effect.runPromise(
      resolveAppPlacement(app, desired.provider).pipe(Effect.provide(harness.layer), Effect.flip),
    );
    expect(error).toBeInstanceOf(AppResolveError);
    if (!(error instanceof AppResolveError)) throw error;
    expect(error.remediation).toContain("lando destroy --provider=lando --yes");
    expect(error.remediation).toContain("lando destroy --provider=docker --yes");
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("an app on its existing provider may reconcile", async () => {
  const harness = makeHarness({ appliedPlans: [applied] });
  try {
    const result = await Effect.runPromise(
      ensureAppPlacement(app, applied.provider).pipe(Effect.provide(harness.layer)),
    );
    expect(result).toBe(applied.provider);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
