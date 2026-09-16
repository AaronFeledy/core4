import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { DateTime, Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AppResolveError, LandofileValidationError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, type LandofileShape, ProviderId } from "@lando/sdk/schema";
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
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeLayer = (input: {
  readonly appliedPlan?: AppPlan;
  readonly desiredPlan?: AppPlan;
  readonly providerId?: string;
  readonly destroy?: () => Effect.Effect<void, ProviderUnavailableError>;
}) => {
  const destroyCalls: AppPlan[] = [];
  let appliedPlan = input.appliedPlan;
  const provider = {
    ...TestRuntimeProvider,
    id: input.providerId ?? "lando",
    destroy: (target: { readonly plan?: AppPlan }, options: { readonly removeState?: boolean }) =>
      Effect.sync(() => {
        if (target.plan !== undefined) destroyCalls.push(target.plan);
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
  };
  const registry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: (_cwd: AbsolutePath) => Effect.succeed(appliedPlan),
  };
  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(PathsService, makeLandoPaths({ env: {}, platform: "linux" })),
    Layer.succeed(LandofileService, {
      discover:
        input.desiredPlan === undefined
          ? Effect.fail(invalidDesiredConfig)
          : Effect.succeed({ name: input.desiredPlan.name, services: {} } satisfies LandofileShape),
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
  return { layer, destroyCalls, appliedPlan: () => appliedPlan };
};

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
      const harness = makeLayer({});

      const first = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );
      const second = await Effect.runPromise(
        withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)),
      );

      expect(first).toEqual({
        app: basename(root),
        outcome: "unchanged",
        servicesDestroyed: [],
        volumesRemoved: false,
      });
      expect(second).toEqual(first);
      expect(harness.destroyCalls).toEqual([]);
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
