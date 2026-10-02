import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { DateTime, Effect, Layer, Stream } from "effect";

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
import type { AppliedOrphanGroup, ListFilter, ServiceRuntimeInfo } from "@lando/sdk/services";
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

import { type ResolvedAppTarget, withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppAtRoot, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopApp, stopAppForTarget } from "../../src/operations/stop.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { web } from "./destroy-progress-topology-support.ts";

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
    resolvedAt: DateTime.makeUnsafe("2026-09-15T00:00:00.000Z"),
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
  readonly observed?: ReadonlyArray<ServiceRuntimeInfo>;
  readonly listFailure?: ProviderUnavailableError;
  readonly removalFailure?: ProviderUnavailableError;
  /** Observed services whose container survives removal; every other one is reported removed. */
  readonly survivingServices?: ReadonlyArray<string>;
}) => {
  const destroyCalls: AppPlan[] = [];
  const mutationOrder: string[] = [];
  const listFilters: ListFilter[] = [];
  const destroyTargets: Array<{
    readonly app: string;
    readonly hasPlan: boolean;
    readonly planRoot: string | undefined;
    readonly volumes: boolean;
  }> = [];
  const removedVolumes: Array<{ readonly store: string; readonly generation: string }> = [];
  const removalAttempts: Array<{ readonly service: string; readonly containerId: string | undefined }> = [];
  const desiredLoads: string[] = [];
  const evidenceRoots: string[] = [];
  let appliedPlan = input.appliedPlan;
  const provider = {
    ...TestRuntimeProvider,
    id: input.providerId ?? "lando",
    list: (filter: ListFilter) =>
      Effect.sync(() => {
        listFilters.push(filter);
      }).pipe(
        Effect.andThen(
          input.listFailure === undefined
            ? Effect.succeed(input.observed ?? [])
            : Effect.fail(input.listFailure),
        ),
      ),
    destroy: (
      target: { readonly app: string; readonly plan?: AppPlan },
      options: { readonly removeState?: boolean; readonly volumes?: boolean },
    ) =>
      Effect.sync(() => {
        mutationOrder.push("destroy");
        if (target.plan !== undefined) destroyCalls.push(target.plan);
        destroyTargets.push({
          app: String(target.app),
          hasPlan: target.plan !== undefined,
          planRoot: target.plan === undefined ? undefined : String(target.plan.root),
          volumes: options.volumes === true,
        });
      }).pipe(
        Effect.andThen(input.destroy?.() ?? Effect.void),
        Effect.tap(() =>
          options.removeState === false
            ? Effect.void
            : Effect.sync(() => {
                appliedPlan = undefined;
              }),
        ),
        Effect.as({ kind: "destroyed" } as const),
      ),
    removeVolume: (ref: { readonly store: string }, expectedGeneration: string) =>
      Effect.sync(() => {
        removedVolumes.push({ store: ref.store, generation: expectedGeneration });
      }),
    removeObservedService: (observed: {
      readonly service: string;
      readonly containerId?: string;
    }) =>
      Effect.sync(() => {
        mutationOrder.push(`remove:${observed.service}`);
        removalAttempts.push({ service: String(observed.service), containerId: observed.containerId });
        const survives =
          observed.containerId === undefined ||
          (input.survivingServices ?? []).includes(String(observed.service));
        return survives ? ({ kind: "absent" } as const) : ({ kind: "removed" } as const);
      }).pipe(
        Effect.tap(() =>
          input.removalFailure === undefined ? Effect.void : Effect.fail(input.removalFailure),
        ),
      ),
  };
  const registry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: (_cwd: AbsolutePath) => Effect.succeed(appliedPlan),
    // Providers answer only for the root they are asked about. Either root field may match, so a
    // malformed plan still reaches the ownership validators under test.
    resolveTeardownEvidence: (root: AbsolutePath) => {
      evidenceRoots.push(root);
      if (
        appliedPlan !== undefined &&
        (appliedPlan.root === root || appliedPlan.identity?.appRoot === root)
      ) {
        return Effect.succeed({ kind: "applied", plan: appliedPlan } as const);
      }
      const groups = (input.orphans ?? []).filter(
        (group) =>
          group.services.some((service) => service.appRoot === root) ||
          group.volumes.some((volume) => volume.identity?.ownerRoot === root),
      );
      if (groups.length > 0) {
        return Effect.succeed({ kind: "orphans", groups } as const);
      }
      return Effect.succeed({ kind: "absent" } as const);
    },
  };
  const layer = Layer.mergeAll(
    FileSystemLive,
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
      subscribe: () => Stream.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );
  return {
    layer,
    mutationOrder,
    listFilters,
    destroyCalls,
    destroyTargets,
    removedVolumes,
    removalAttempts,
    desiredLoads,
    evidenceRoots,
    appliedPlan: () => appliedPlan,
  };
};

const orphanVolume = (root: string, store: string, scope = "app"): VolumeInfo => ({
  ref: { app: AppId.make("applied-teardown"), store },
  labels: {
    "dev.lando.app": "applied-teardown",
    "dev.lando.store": store,
    "dev.lando.scope": scope,
    ...(store === "cache" ? { "dev.lando.storage-kind": "cache" } : {}),
  },
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
  readonly globalVolumes?: ReadonlyArray<string>;
  /** Observed services the provider could not address, so they carry no container id. */
  readonly withoutContainerId?: ReadonlyArray<string>;
}): AppliedOrphanGroup => ({
  providerId,
  appId: AppId.make("applied-teardown"),
  services: (input.services ?? []).map((name) => ({
    app: AppId.make("applied-teardown"),
    appRoot: AbsolutePath.make(input.root),
    service: ServiceName.make(name),
    providerId,
    status: "running",
    ...((input.withoutContainerId ?? []).includes(name) ? {} : { containerId: `container-${name}` }),
  })),
  volumes: [
    ...(input.volumes ?? []).map((store) => orphanVolume(input.root, store)),
    ...(input.globalVolumes ?? []).map((store) => orphanVolume(input.root, store, "global")),
  ],
});

describe("applied-state teardown", () => {
  test.each(["cwd", "root"] as const)(
    "%s destroy removes only same-app, same-root stray containers before the plan",
    async (mode) => {
      await withTempRoot(async (parent) => {
        const root = mode === "root" ? join(parent, "gone") : parent;
        const appliedPlan = { ...planAt(root), services: { [web.name]: web } };
        const observed = orphanGroup({
          root,
          services: ["stray", "web", "unobserved"],
          withoutContainerId: ["unobserved"],
        }).services;
        const harness = makeLayer({
          appliedPlan,
          observed: [
            ...observed,
            ...orphanGroup({ root: join(parent, "other"), services: ["other-root"] }).services,
            {
              ...observed[0],
              app: AppId.make("other-app"),
              service: ServiceName.make("other-app"),
              appRoot: AbsolutePath.make(root),
              providerId,
              status: "running",
              containerId: "foreign",
            },
          ],
        });
        await Effect.runPromise(
          (mode === "root" ? destroyAppAtRoot(root) : withResolvedCwd(root, destroyApp())).pipe(
            Effect.provide(harness.layer),
          ),
        );
        expect(harness.mutationOrder).toEqual(["remove:stray", "destroy"]);
        expect(harness.removalAttempts).toEqual([{ service: "stray", containerId: "container-stray" }]);
        expect(harness.listFilters).toEqual([{ app: appliedPlan.id, includeUnplanned: true }]);
      });
    },
  );

  test("destroy continues when stray inventory fails", async () => {
    await withTempRoot(async (root) => {
      const appliedPlan = planAt(root);
      const harness = makeLayer({
        appliedPlan,
        listFailure: new ProviderUnavailableError({
          providerId,
          operation: "list",
          message: "Cannot inventory containers.",
        }),
      });
      await Effect.runPromise(withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)));
      expect(harness.destroyCalls).toEqual([appliedPlan]);
      expect(harness.removalAttempts).toEqual([]);
    });
  });

  test("destroy propagates stray removal failure before destroying the plan", async () => {
    await withTempRoot(async (root) => {
      const failure = new ProviderUnavailableError({
        providerId,
        operation: "removeObservedService",
        message: "Cannot remove stray container.",
      });
      const harness = makeLayer({
        appliedPlan: planAt(root),
        observed: orphanGroup({ root, services: ["stray"] }).services,
        removalFailure: failure,
      });
      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure });
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test("destroy skips stray inventory for the global app", async () => {
    await withTempRoot(async (root) => {
      const appliedPlan = { ...planAt(root), id: AppId.make("global") };
      const harness = makeLayer({ appliedPlan });
      await Effect.runPromise(withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)));
      expect(harness.listFilters).toEqual([]);
      expect(harness.destroyCalls).toEqual([appliedPlan]);
    });
  });
  test.each([
    [
      "identity",
      (plan: AppPlan): AppPlan => {
        const { identity, ...rest } = plan;
        return rest;
      },
    ],
    [
      "canonical-root",
      (plan: AppPlan): AppPlan => ({
        ...plan,
        identity: { appRoot: AbsolutePath.make("/other/root"), ownerKey: "other" },
      }),
    ],
    ["provider", (plan: AppPlan): AppPlan => ({ ...plan, provider: ProviderId.make("docker") })],
    [
      "owner-key",
      (plan: AppPlan): AppPlan => ({
        ...plan,
        identity: { appRoot: plan.root, ownerKey: ownerKey("/somewhere/else") },
      }),
    ],
  ] as const)("destroy at a missing root rejects mismatched %s before mutation", async (detail, mutate) => {
    await withTempRoot(async (parent) => {
      const root = join(parent, "gone");
      const harness = makeLayer({ appliedPlan: mutate(planAt(root)) });
      const result = await Effect.runPromise(
        destroyAppAtRoot(root).pipe(Effect.provide(harness.layer), Effect.result),
      );
      if (result._tag !== "Failure") throw new TypeError("expected ownership refusal");
      expect(result.failure).toMatchObject({ _tag: "AppResolveError", reason: "mismatch", detail });
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test("destroy at root refuses an existing folder before provider access", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ appliedPlan: planAt(root) });
      const result = await Effect.runPromise(
        destroyAppAtRoot(root).pipe(Effect.provide(harness.layer), Effect.result),
      );
      if (result._tag !== "Failure") throw new TypeError("expected existing-root refusal");
      expect(result.failure).toMatchObject({
        _tag: "AppResolveError",
        reason: "mismatch",
        detail: "root-exists",
      });
      expect(harness.evidenceRoots).toEqual([]);
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test.each(["dangling-symlink", "non-directory-parent"] as const)(
    "destroy at root explains an unresolvable path under a %s before provider access",
    async (kind) => {
      await withTempRoot(async (parent) => {
        const broken = join(parent, "broken");
        if (kind === "dangling-symlink") await symlink(join(parent, "absent-target"), broken);
        else await Bun.write(broken, "not a folder");
        const root = join(broken, "gone");
        const harness = makeLayer({});
        const result = await Effect.runPromise(
          destroyAppAtRoot(root).pipe(Effect.provide(harness.layer), Effect.result),
        );
        if (result._tag !== "Failure") throw new TypeError("expected unresolvable-root refusal");
        expect(result.failure).toMatchObject({
          _tag: "AppResolveError",
          reason: "missing-root",
          detail: "unresolvable-root",
          message: `The app folder path ${root} cannot be resolved.`,
          remediation:
            kind === "dangling-symlink"
              ? `Part of ${root} is a symlink whose target no longer exists. Remove or fix that symlink, then rerun lando destroy --root ${root}.`
              : `Check that you can read every folder in ${root}, then rerun.`,
        });
        expect(harness.evidenceRoots).toEqual([]);
        expect(harness.destroyCalls).toEqual([]);
      });
    },
  );

  test("destroy at a missing root uses its applied plan without loading the folder", async () => {
    await withTempRoot(async (parent) => {
      const root = join(parent, "gone");
      const appliedPlan = planAt(root);
      const harness = makeLayer({ appliedPlan });
      const result = await Effect.runPromise(destroyAppAtRoot(root).pipe(Effect.provide(harness.layer)));
      expect(result.outcome).toBe("destroyed");
      expect(harness.destroyCalls).toEqual([appliedPlan]);
      expect(harness.desiredLoads).toEqual([]);
      expect(harness.evidenceRoots).toEqual([root, root]);
    });
  });

  test.each([
    { volumes: false, purgeCaches: false, removed: [] },
    { volumes: true, purgeCaches: false, removed: ["database"] },
    { volumes: false, purgeCaches: true, removed: ["cache"] },
    { volumes: true, purgeCaches: true, removed: ["database", "cache"] },
  ])(
    "destroy at a missing root honors orphan storage options %j",
    async ({ volumes, purgeCaches, removed }) => {
      await withTempRoot(async (parent) => {
        const root = join(parent, "gone");
        const harness = makeLayer({
          orphans: [orphanGroup({ root, services: ["web"], volumes: ["database", "cache"] })],
        });
        const result = await Effect.runPromise(
          destroyAppAtRoot(root, { volumes, purgeCaches }).pipe(Effect.provide(harness.layer)),
        );
        expect(result).toMatchObject({
          outcome: "destroyed",
          servicesDestroyed: ["web"],
          volumesRemoved: removed.length > 0,
        });
        expect(harness.removedVolumes.map((volume) => volume.store)).toEqual([...removed]);
        expect(harness.destroyCalls).toEqual([]);
      });
    },
  );

  test("destroy at an absent missing root returns unchanged without desired config", async () => {
    await withTempRoot(async (parent) => {
      const harness = makeLayer({});
      const result = await Effect.runPromise(
        destroyAppAtRoot(join(parent, "gone")).pipe(Effect.provide(harness.layer)),
      );
      expect(result).toEqual({
        app: "gone",
        outcome: "unchanged",
        servicesDestroyed: [],
        volumesRemoved: false,
      });
      expect(harness.destroyCalls).toEqual([]);
      expect(harness.desiredLoads).toEqual([]);
    });
  });

  test("destroy at a missing root removes orphan leftovers after the applied plan in one run", async () => {
    await withTempRoot(async (parent) => {
      const root = join(parent, "gone");
      const appliedPlan = planAt(root);
      const harness = makeLayer({
        appliedPlan,
        orphans: [orphanGroup({ root, services: ["leftover"], volumes: ["cache"] })],
      });
      const result = await Effect.runPromise(
        destroyAppAtRoot(root, { purgeCaches: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(harness.destroyCalls).toEqual([appliedPlan]);
      expect(harness.removalAttempts).toEqual([{ service: "leftover", containerId: "container-leftover" }]);
      expect(harness.removedVolumes).toEqual([{ store: "cache", generation: "generation-cache" }]);
      expect(result).toMatchObject({
        outcome: "destroyed",
        servicesDestroyed: ["leftover"],
        volumesRemoved: true,
      });
      expect(harness.evidenceRoots).toEqual([root, root]);
    });
  });

  test("destroy at a missing root canonicalizes a symlinked parent before resolving evidence", async () => {
    await withTempRoot(async (parent) => {
      const alias = join(parent, "alias");
      await symlink(parent, alias);
      const root = join(parent, "gone");
      const appliedPlan = planAt(root);
      const harness = makeLayer({ appliedPlan });
      const result = await Effect.runPromise(
        destroyAppAtRoot(join(alias, "gone")).pipe(Effect.provide(harness.layer)),
      );
      expect(result.outcome).toBe("destroyed");
      expect(harness.evidenceRoots).toEqual([join(alias, "gone"), root, root]);
      expect(harness.destroyCalls).toEqual([appliedPlan]);
    });
  });

  test("destroy at a missing root finds the recorded path after its parent became a symlink", async () => {
    await withTempRoot(async (parent) => {
      // Given an app recorded under projects/, which was later moved and replaced by a symlink.
      await mkdir(join(parent, "new-projects"));
      await symlink(join(parent, "new-projects"), join(parent, "projects"));
      const recorded = join(parent, "projects", "gone");
      const appliedPlan = planAt(recorded);
      const harness = makeLayer({ appliedPlan });

      // When the user passes the path doctor printed.
      const result = await Effect.runPromise(destroyAppAtRoot(recorded).pipe(Effect.provide(harness.layer)));

      // Then the recorded path wins over the symlink's current destination.
      expect(result.outcome).toBe("destroyed");
      expect(harness.evidenceRoots).toEqual([recorded, recorded]);
      expect(harness.destroyCalls).toEqual([appliedPlan]);
    });
  });

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
      expect(harness.removedVolumes).toEqual([{ store: "database", generation: "generation-database" }]);
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
        expect(harness.removalAttempts).toEqual([
          { service: "appserver", containerId: "container-appserver" },
          { service: "database", containerId: "container-database" },
        ]);
        expect(harness.destroyTargets).toEqual([]);
        expect(harness.desiredLoads).toEqual([]);
      });
    },
  );

  test.each(["stop", "destroy"] as const)(
    "%s reports only the orphaned services whose container was removed",
    async (operation) => {
      await withTempRoot(async (root) => {
        const harness = makeLayer({
          orphans: [orphanGroup({ root, services: ["appserver", "database"] })],
          survivingServices: ["database"],
        });

        const result =
          operation === "stop"
            ? await Effect.runPromise(withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(
                withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
              );

        expect(
          operation === "stop"
            ? (result as { readonly servicesStopped: ReadonlyArray<string> }).servicesStopped
            : (result as { readonly servicesDestroyed: ReadonlyArray<string> }).servicesDestroyed,
        ).toEqual(["appserver"]);
        expect(harness.removalAttempts).toEqual([
          { service: "appserver", containerId: "container-appserver" },
          { service: "database", containerId: "container-database" },
        ]);
        expect(harness.destroyTargets).toEqual([]);
      });
    },
  );

  test("an orphaned service with no observed container is neither removed nor reported", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({
        orphans: [orphanGroup({ root, services: ["appserver"], withoutContainerId: ["appserver"] })],
      });

      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(result.outcome).toBe("unchanged");
      expect(result.servicesDestroyed).toEqual([]);
      expect(harness.removalAttempts).toEqual([{ service: "appserver", containerId: undefined }]);
    });
  });

  test("destroy removes only cache orphan volumes when just caches are purged", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ orphans: [orphanGroup({ root, volumes: ["database", "cache"] })] });

      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp({ purgeCaches: true })).pipe(Effect.provide(harness.layer)),
      );

      expect(result.volumesRemoved).toBe(true);
      expect(harness.removedVolumes).toEqual([{ store: "cache", generation: "generation-cache" }]);
    });
  });

  test("destroy removes both orphan volume classes when volumes and caches are requested", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({ orphans: [orphanGroup({ root, volumes: ["database", "cache"] })] });

      await Effect.runPromise(
        withResolvedCwd(root, destroyApp({ volumes: true, purgeCaches: true })).pipe(
          Effect.provide(harness.layer),
        ),
      );

      expect(harness.removedVolumes).toEqual([
        { store: "database", generation: "generation-database" },
        { store: "cache", generation: "generation-cache" },
      ]);
    });
  });

  test.each([
    { volumes: false, purgeCaches: false, removed: [] },
    { volumes: true, purgeCaches: false, removed: [] },
    { volumes: false, purgeCaches: true, removed: [{ store: "cache", generation: "generation-cache" }] },
    { volumes: true, purgeCaches: true, removed: [{ store: "cache", generation: "generation-cache" }] },
  ])("destroy selects global orphan volumes with %j", async ({ volumes, purgeCaches, removed }) => {
    await withTempRoot(async (root) => {
      // Given globally scoped cache and data volumes with no surviving applied plan.
      const harness = makeLayer({ orphans: [orphanGroup({ root, globalVolumes: ["cache", "shared"] })] });

      // When the requested volume classes are torn down.
      const result = await Effect.runPromise(
        withResolvedCwd(root, destroyApp({ volumes, purgeCaches })).pipe(Effect.provide(harness.layer)),
      );

      // Then only an explicitly purged cache is removed; global data always survives.
      expect(harness.removedVolumes).toEqual([...removed]);
      expect(result.volumesRemoved).toBe(purgeCaches);
    });
  });

  test("destroy leaves a globally scoped orphan volume alone", async () => {
    await withTempRoot(async (root) => {
      const harness = makeLayer({
        orphans: [orphanGroup({ root, volumes: ["database"], globalVolumes: ["shared"] })],
      });

      await Effect.runPromise(
        withResolvedCwd(root, destroyApp({ volumes: true })).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.removedVolumes).toEqual([{ store: "database", generation: "generation-database" }]);
    });
  });

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
