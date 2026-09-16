import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { openLandoRuntime } from "@lando/core";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/core/schema";
import { RouterService, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { TestRouterService } from "@lando/sdk/test";

const providerId = ProviderId.make(TestRuntimeProvider.id);

const ownerKey = (root: string): string => createHash("sha256").update(`owner\0${root}`).digest("hex");

const appliedPlanAt = (root: string): AppPlan => ({
  id: AppId.make("library-applied-teardown"),
  name: "library-applied-teardown",
  slug: "library-applied-teardown",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
  provider: providerId,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-16T00:00:00.000Z"),
    source: "app-handle-applied-teardown.test",
    runtime: 4,
  },
  extensions: {},
});

const withEmptyAppRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-library-applied-teardown-")));
  const original = process.cwd();
  process.chdir(root);
  try {
    return await use(root);
  } finally {
    process.chdir(original);
    await rm(root, { recursive: true, force: true });
  }
};

describe("@lando/core applied-state App handle teardown", () => {
  test("a fresh runtime resolves missing desired config and runs stop then destroy from applied state", async () => {
    await withEmptyAppRoot(async (root) => {
      let appliedPlan: AppPlan | undefined = appliedPlanAt(root);
      const destroyCalls: Array<{ readonly removeState?: boolean; readonly volumes: boolean }> = [];
      const provider = {
        ...TestRuntimeProvider,
        appliedPlans: Effect.sync(() => (appliedPlan === undefined ? [] : [appliedPlan])),
        destroy: (_target: unknown, options: { readonly removeState?: boolean; readonly volumes: boolean }) =>
          Effect.sync(() => {
            destroyCalls.push(options);
            if (options.removeState !== false) appliedPlan = undefined;
          }),
      };
      const layers = [
        Layer.succeed(RuntimeProvider, provider),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
          resolveAppliedPlan: () => Effect.sync(() => appliedPlan),
        }),
        Layer.succeed(RouterService, TestRouterService),
      ];

      const result = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({ plugins: { policy: "bundled-only", layers } }).pipe(
            Effect.flatMap((runtime) => runtime.app()),
            Effect.flatMap((app) =>
              app
                .stop()
                .pipe(
                  Effect.flatMap((stopped) =>
                    app.destroy().pipe(Effect.map((destroyed) => ({ stopped, destroyed }))),
                  ),
                ),
            ),
          ),
        ),
      );

      expect(result.stopped.app).toBe("library-applied-teardown");
      expect(result.destroyed.app).toBe("library-applied-teardown");
      expect(destroyCalls).toEqual([
        { removeState: false, volumes: false },
        { removeState: true, volumes: false },
      ]);
      expect(appliedPlan).toBeUndefined();
    });
  });
});
