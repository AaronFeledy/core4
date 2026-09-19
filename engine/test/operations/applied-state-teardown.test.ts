import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { DateTime, Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AppResolveError, LandofileValidationError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  ProviderId,
  ServiceName,
  type VolumeInfo,
} from "@lando/sdk/schema";
import type { AppliedOrphanGroup } from "@lando/sdk/services";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";

import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopApp, stopAppForTarget } from "../../src/operations/stop.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const providerId = ProviderId.make("lando");

const ownerKey = (root: string): string => createHash("sha256").update(`owner\0${root}`).digest("hex");

const planAt = (root: string): AppPlan => ({
  id: AppId.make("applied-teardown"),
  name: "applied-teardown",
  slug: "applied-teardown",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
  provider: providerId,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-15T00:00:00.000Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const targetFor = (plan: AppPlan, root = plan.root): ResolvedAppTarget => ({
  plan,
  root,
  app: { kind: "user", id: plan.id, root },
});

const appliedPlanMismatches: ReadonlyArray<readonly [string, (plan: AppPlan) => AppPlan]> = [
  ["canonical root", (plan) => ({ ...plan, root: AbsolutePath.make("/tmp/other-root") })],
  ["owner key", (plan) => ({ ...plan, identity: { appRoot: plan.root, ownerKey: "different-owner" } })],
  ["provider", (plan) => ({ ...plan, provider: ProviderId.make("docker") })],
];

const invalidDesiredConfig = new LandofileValidationError({
  message: "The current Landofile is invalid.",
  file: ".lando.yml",
  issues: ["invalid test fixture"],
});

const withTempRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-applied-teardown-")));
  await Bun.write(join(root, ".lando.yml"), "name: applied-teardown\n");
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeLayer = (input: {
  readonly appliedPlan?: AppPlan;
  readonly desiredPlan?: AppPlan;
  readonly orphans?: ReadonlyArray<AppliedOrphanGroup>;
  readonly providerId?: string;
  readonly destroy?: () => Effect.Effect<void, ProviderUnavailableError>;
}) => {
  const destroyCalls: AppPlan[] = [];
  const destroyTargets: Array<{
    readonly app: string;
    readonly hasPlan: boolean;
    readonly volumes: boolean;
  }> = [];
  const removedVolumes: Array<{ readonly store: string; readonly generation: string }> = [];
  const desiredLoads: string[] = [];
  let appliedPlan = input.appliedPlan;
  const provider = {
    ...TestRuntimeProvider,
    id: input.providerId ?? "lando",
    destroy: (
      target: { readonly app: string; readonly plan?: AppPlan },
      options: { readonly removeState?: boolean; readonly volumes?: boolean },
    ) =>
      Effect.sync(() => {
        if (target.plan !== undefined) destroyCalls.push(target.plan);
        destroyTargets.push({
          app: String(target.app),
          hasPlan: target.plan !== undefined,
          volumes: options.volumes === true,
        });
      }).pipe(
        Effect.zipRight(input.destroy?.() ?? Effect.void),
        Effect.tap(() =>
          options.removeState === false
            ? Effect.void
            : Effect.sync(() => {
                appliedPlan = undefined;
              }),
        ),
      ),
    removeVolume: (ref: { readonly store: string }, expectedGeneration: string) =>
      Effect.sync(() => {
        removedVolumes.push({ store: ref.store, generation: expectedGeneration });
      }),
  };
  const registry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: (_cwd: AbsolutePath) => Effect.succeed(appliedPlan),
    resolveTeardownEvidence: (_root: AbsolutePath) =>
      Effect.succeed(
        appliedPlan !== undefined
          ? ({ kind: "applied", plan: appliedPlan } as const)
          : input.orphans !== undefined && input.orphans.length > 0
            ? ({ kind: "orphans", groups: input.orphans } as const)
            : ({ kind: "absent" } as const),
      ),
  };
  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(PathsService, makeLandoPaths({ env: {}, platform: "linux" })),
    Layer.succeed(LandofileService, {
      discover: Effect.suspend(() => {
        desiredLoads.push("discover");
        return input.desiredPlan === undefined
          ? Effect.fail(invalidDesiredConfig)
          : Effect.succeed({ name: input.desiredPlan.name, services: {} } satisfies LandofileShape);
      }),
    }),
    Layer.succeed(AppPlanner, {
      plan: () =>
        input.desiredPlan === undefined
          ? Effect.die("desired planning must not run")
          : Effect.succeed(input.desiredPlan),
    }),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(EventService, {
      publish: () => Effect.void,
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );
  return {
    layer,
    destroyCalls,
    destroyTargets,
    removedVolumes,
    desiredLoads,
    appliedPlan: () => appliedPlan,
  };
};

const orphanVolume = (root: string, store: string): VolumeInfo => ({
  ref: { app: AppId.make("applied-teardown"), store },
  identity: {
    coordinationKey: `lando:applied-teardown:${store}`,
    nativeName: `applied-teardown_${store}`,
    generation: `generation-${store}`,
    ownerRoot: AbsolutePath.make(root),
    origin: "created",
  },
});

const orphanGroup = (input: {
  readonly root: string;
  readonly services?: ReadonlyArray<string>;
  readonly volumes?: ReadonlyArray<string>;
}): AppliedOrphanGroup => ({
  providerId,
  appId: AppId.make("applied-teardown"),
  services: (input.services ?? []).map((name) => ({
    app: AppId.make("applied-teardown"),
    appRoot: AbsolutePath.make(input.root),
    service: ServiceName.make(name),
    providerId,
    status: "running",
  })),
  volumes: (input.volumes ?? []).map((store) => orphanVolume(input.root, store)),
});

describe("applied-state teardown", () => {
  test("tears down from the last applied plan when desired config is invalid", async () => {
    await withTempRoot(async (root) => {
      const appliedPlan = planAt(root);
      const harness = makeLayer({ appliedPlan });

      const result = await Effect.runPromise(
        withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(result).toEqual({ app: appliedPlan.name, outcome: "stopped", servicesStopped: [] });
      expect(harness.destroyCalls).toEqual([appliedPlan]);
      expect(harness.appliedPlan()).toEqual(appliedPlan);
    });
  });

  test.each(appliedPlanMismatches)("rejects an applied plan whose %s differs", async (_case, mutate) => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ appliedPlan: mutate(planAt(root)) });

      const exit = await Effect.runPromiseExit(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(exit._tag).toBe("Failure");
      expect(harness.destroyCalls).toEqual([]);
      const failure = exit._tag === "Failure" ? exit.cause : undefined;
      expect(String(failure)).toContain(AppResolveError.name);
    });
  });

  test.each([["stop"], ["destroy"]] as const)(
    "%s revalidates a resolved target before provider mutation",
    async (operation) => {
      await withTempRoot(async (root) => {
        for (const [, mutate] of appliedPlanMismatches) {
          const plan = planAt(root);
          const harness = makeLayer({ appliedPlan: plan });
          const mismatched = mutate(plan);
          const exit =
            operation === "stop"
              ? await Effect.runPromiseExit(
                  stopAppForTarget(undefined, targetFor(mismatched)).pipe(Effect.provide(harness.layer)),
                )
              : await Effect.runPromiseExit(
                  destroyAppForTarget(undefined, targetFor(mismatched)).pipe(Effect.provide(harness.layer)),
                );

          expect(exit._tag).toBe("Failure");
          expect(harness.destroyCalls).toEqual([]);
          expect(String(exit)).toContain(AppResolveError.name);
        }
      });
    },
  );

  test("returns the same explicit idempotent result when no applied state or owned resources exist", async () => {
    await withTempRoot(async (root) => {
      const desiredPlan = planAt(root);
      const harness = makeLayer({ desiredPlan });

      const first = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );
      const second = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(first).toEqual({
        app: desiredPlan.name,
        outcome: "unchanged",
        servicesDestroyed: [],
        volumesRemoved: false,
      });
      expect(second).toEqual(first);
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test.each(["stop", "destroy"] as const)(
    "%s reports unchanged for a never-started app whose desired config never validates",
    async (operation) => {
      await withTempRoot(async (root) => {
        const harness = makeLayer({});
        const result =
          operation === "stop"
            ? await Effect.runPromise(withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(
                withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
              );

        expect(result.outcome).toBe("unchanged");
        expect(result.app).toBe(basename(root));
        expect(harness.destroyCalls).toEqual([]);
        expect(harness.destroyTargets).toEqual([]);
      });
    },
  );

  test.each(["stop", "destroy"] as const)(
    "%s consults applied state before it loads the desired config",
    async (operation) => {
      await withTempRoot(async (root) => {
        const appliedPlan = planAt(root);
        const harness = makeLayer({ appliedPlan, desiredPlan: planAt(root) });

        if (operation === "stop") {
          await Effect.runPromise(withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)));
        } else {
          await Effect.runPromise(withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)));
        }

        expect(harness.desiredLoads).toEqual([]);
        expect(harness.destroyCalls).toEqual([appliedPlan]);
      });
    },
  );

  test("destroy removes owned volumes left behind without an applied plan", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ orphans: [orphanGroup({ root, volumes: ["database", "cache"] })] });

      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp({ volumes: true })).pipe(Effect.provide(harness.layer)),
      );

      expect(result).toEqual({
        app: "applied-teardown",
        outcome: "destroyed",
        servicesDestroyed: [],
        volumesRemoved: true,
      });
      expect(harness.removedVolumes).toEqual([
        { store: "database", generation: "generation-database" },
        { store: "cache", generation: "generation-cache" },
      ]);
    });
  });

  test("destroy leaves retained volumes alone when volume removal was not requested", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ orphans: [orphanGroup({ root, volumes: ["database"] })] });

      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(result.outcome).toBe("unchanged");
      expect(harness.removedVolumes).toEqual([]);
      expect(harness.destroyTargets).toEqual([]);
    });
  });

  test("stop never removes owned volumes left behind without an applied plan", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ orphans: [orphanGroup({ root, volumes: ["database"] })] });

      const result = await Effect.runPromise(
        withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(result.outcome).toBe("unchanged");
      expect(harness.removedVolumes).toEqual([]);
      expect(harness.destroyTargets).toEqual([]);
    });
  });

  test.each(["stop", "destroy"] as const)(
    "%s tears down orphaned services of the app root and reports them",
    async (operation) => {
      await withTempRoot(async (root) => {
        const harness = makeLayer({ orphans: [orphanGroup({ root, services: ["appserver", "database"] })] });

        if (operation === "stop") {
          const result = await Effect.runPromise(
            withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)),
          );
          expect(result.app).toBe("applied-teardown");
          expect(result.outcome).toBe("stopped");
          expect(result.servicesStopped).toEqual(["appserver", "database"]);
        } else {
          const result = await Effect.runPromise(
            withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
          );
          expect(result.app).toBe("applied-teardown");
          expect(result.outcome).toBe("destroyed");
          expect(result.servicesDestroyed).toEqual(["appserver", "database"]);
        }
        expect(harness.destroyTargets).toEqual([{ app: "applied-teardown", hasPlan: false, volumes: false }]);
        expect(harness.desiredLoads).toEqual([]);
      });
    },
  );

  test.each(["stop", "destroy"] as const)(
    "%s returns unchanged for a valid never-started app without provider mutation",
    async (operation) => {
      await withTempRoot(async (root) => {
        const desiredPlan = planAt(root);
        const harness = makeLayer({ desiredPlan });

        const result =
          operation === "stop"
            ? await Effect.runPromise(withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(
                withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
              );

        expect(result.outcome).toBe("unchanged");
        expect(harness.destroyCalls).toEqual([]);
      });
    },
  );

  test("clears applied state only after destroy succeeds", async () => {
    await withTempRoot(async (root) => {
      const appliedPlan = planAt(root);
      const failure = new ProviderUnavailableError({
        providerId: "lando",
        operation: "destroy",
        message: "runtime unavailable",
      });
      const harness = makeLayer({ appliedPlan, destroy: () => Effect.fail(failure) });

      await Effect.runPromiseExit(withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)));

      expect(harness.destroyCalls).toEqual([appliedPlan]);
      expect(harness.appliedPlan()).toEqual(appliedPlan);
    });
  });
});
