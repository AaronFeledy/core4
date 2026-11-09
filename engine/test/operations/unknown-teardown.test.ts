import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, LoadScopedLandofile, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { destroyApp, destroyAppAtRoot, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { globalDestroy } from "../../src/operations/global-destroy.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";
import { stoppedProviderInspection } from "./stopped-provider-support.ts";

const statusFailure = new ProviderUnavailableError({
  providerId: "lando",
  operation: "getStatus",
  message: "No shutdown receipt after crash.",
  remediation: "Repair runtime access.",
});
const readinessFailure = new ProviderUnavailableError({
  providerId: "lando",
  operation: "ensureReady",
  message: "Runtime admission failed.",
  remediation: "Repair runtime admission.",
});

test.each(
  (["destroy", "destroy-target", "destroy-root", "global-destroy"] as const).flatMap((operation) =>
    (["ready", "no-ensure-ready", "readiness-fails"] as const).map((mode) => ({ operation, mode })),
  ),
)("$operation handles an unknown owning runtime: $mode", async ({ operation, mode }) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-unknown-teardown-")));
  try {
    let running = false;
    let preparations = 0;
    let destroyed = 0;
    const getStatus = Effect.suspend(() =>
      running ? Effect.succeed({ state: "running" as const }) : Effect.fail(statusFailure),
    );
    const ensureReady = Effect.sync(() => {
      preparations++;
    }).pipe(
      Effect.andThen(
        mode === "readiness-fails"
          ? Effect.fail(readinessFailure)
          : Effect.sync(() => {
              running = true;
            }),
      ),
    );
    const root = AbsolutePath.make(join(base, operation === "global-destroy" ? "global" : "app"));
    if (operation !== "destroy-root") await mkdir(root);
    const applied =
      operation === "global-destroy"
        ? globalPlanAt(root)
        : {
            ...plan,
            root,
            identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
          };
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      getStatus,
      ...(mode === "no-ensure-ready" ? {} : { ensureReady }),
      inspectAppliedFileSync: stoppedProviderInspection("stopped Windows", () => running),
      destroy: () =>
        Effect.sync(() => {
          expect(running).toBe(true);
          destroyed++;
          return { kind: "destroyed" as const };
        }),
    };
    const harness = makeHarness({
      plannedApp: applied,
      appliedPlans: [applied],
      selectProvider: () => Effect.succeed(provider),
      resolveAppliedPlan: () => Effect.succeed(applied),
    });
    const target = { plan: applied, root, app: { kind: "user" as const, id: applied.id, root } };
    const global =
      operation === "global-destroy"
        ? await globalTeardownHarness(base, {
            plan: applied,
            status: getStatus,
            ensureReady: mode === "no-ensure-ready" ? null : ensureReady,
          })
        : undefined;
    const result =
      global === undefined
        ? await Effect.runPromise(
            (operation === "destroy-root"
              ? destroyAppAtRoot(root, { yes: true })
              : operation === "destroy-target"
                ? destroyAppForTarget({ yes: true }, target)
                : withDiscoveryCwd(root, destroyApp({ yes: true }))
            ).pipe(Effect.provide(harness.layer), Effect.result),
          )
        : await Effect.runPromise(
            globalDestroy({ yes: true }).pipe(Effect.provide(global.layer), Effect.result),
          );
    if (mode === "ready") {
      expect(result).toMatchObject({ _tag: "Success", success: { outcome: "destroyed" } });
      expect(preparations).toBe(1);
      expect(
        global === undefined ? destroyed : global.calls.filter((call) => call === "destroy").length,
      ).toBe(1);
    } else {
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: mode === "readiness-fails" ? readinessFailure : statusFailure,
      });
      expect(preparations).toBe(mode === "readiness-fails" ? 1 : 0);
      expect(destroyed).toBe(0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("stop never prepares an owner whose runtime status fails", async () => {
  let preparations = 0;
  const harness = makeHarness({
    appliedPlans: [plan],
    providerOverrides: {
      getStatus: Effect.fail(statusFailure),
      ensureReady: Effect.sync(() => {
        preparations++;
      }),
    },
  });
  const result = await Effect.runPromise(
    stopAppForTarget(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(Effect.provide(harness.layer), Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: statusFailure });
  expect(preparations).toBe(0);
});

test("destroy of an app with no recorded resources never starts its idle runtime", async () => {
  let preparations = 0;
  const harness = makeHarness({
    appliedPlans: [],
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    providerOverrides: {
      getStatus: Effect.succeed({ state: "idle" as const }),
      ensureReady: Effect.sync(() => {
        preparations++;
      }),
    },
  });
  const result = await Effect.runPromise(
    destroyAppForTarget(
      { yes: true },
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
        landofile: LoadScopedLandofile.make({
          stage: "load-scoped",
          document: { name: plan.name },
          pendingSites: [],
          context: { appRoot: plan.root, env: {} },
        }),
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(result.outcome).toBe("unchanged");
  expect(preparations).toBe(0);
});

test("destroy with an explicit provider reads only that provider's applied state", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-scoped-teardown-")));
  try {
    const root = AbsolutePath.make(join(base, "app"));
    await mkdir(root);
    const applied = { ...plan, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } };
    let running = false;
    const harness = makeHarness({
      plannedApp: applied,
      appliedPlans: [applied],
      resolveAppliedPlan: () => Effect.succeed(applied),
      providerOverrides: {
        getStatus: Effect.sync(() => ({ state: running ? ("running" as const) : ("idle" as const) })),
        ensureReady: Effect.sync(() => {
          running = true;
        }),
        appliedPlans: Effect.succeed([applied]),
      },
    });
    const unrelated = new ProviderUnavailableError({
      providerId: "docker",
      operation: "appliedPlans",
      message: "Another provider's applied state is unreadable.",
      remediation: "Repair that provider.",
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* destroyApp(
          { yes: true, providerId: ProviderId.make("lando") },
          { plan: applied, root, app: { kind: "user", id: applied.id, root } },
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry,
            // Only an unscoped read reaches the unreadable provider.
            appliedPlansFor: (root, providerId) =>
              providerId === "lando" ? registry.appliedPlansFor(root, providerId) : Effect.fail(unrelated),
          }),
        );
      }).pipe(Effect.provide(harness.layer), Effect.result),
    );
    expect(result).toMatchObject({ _tag: "Success" });
    expect(running).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
