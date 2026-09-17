import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";

import { Effect, Layer } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { validateResolvedAppTarget } from "../../src/operations/applied-state-target.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

test("uses the canonical Windows root when planning a teardown target", async () => {
  // Given: discovery retained a Windows short path, while realpath returns its long form.
  const discoveredRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app";
  const canonicalRoot = AbsolutePath.make("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app");
  const realpath = spyOn(fs, "realpath").mockResolvedValue(canonicalRoot);
  const landofile = rememberLandofileAppRoot(
    { name: "embedded-app", runtime: 4 as const, provider: ProviderId.make("test") },
    discoveredRoot,
  );
  try {
    // When: the real planner produces the root-bound plan consumed by teardown.
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
        Effect.provide(AppPlannerLive.pipe(Layer.provide(PluginRegistryLive))),
      ),
    );

    // Then: both ownership fields use the canonical root and pass the unchanged safety checks.
    expect(plan.root).toBe(canonicalRoot);
    expect(plan.identity?.appRoot).toBe(canonicalRoot);
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
    await Effect.runPromise(
      validateResolvedAppTarget(target).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
      ),
    );
  } finally {
    realpath.mockRestore();
  }
});
