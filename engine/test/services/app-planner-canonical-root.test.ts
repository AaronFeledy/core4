import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, realpath as realpathNative, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { validateResolvedAppTarget } from "../../src/operations/applied-state-target.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const slowBindCapabilities = {
  ...TestRuntimeProvider.capabilities,
  bindMountPerformance: "slow" as const,
};

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
        Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))),
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

test("plans file-sync sessions and bind mounts on the canonical Windows root", async () => {
  const canonicalRoot = AbsolutePath.make(
    await realpathNative(await mkdtemp(join(tmpdir(), "lando-canonical-root-"))),
  );
  const discoveredRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app";
  const original = fs.realpath.bind(fs);
  const realpath = spyOn(fs, "realpath").mockImplementation(async (input) => {
    const value = String(input);
    if (value.includes("RUNNER~1") || value === discoveredRoot) return canonicalRoot;
    return original(input);
  });
  const landofile = rememberLandofileAppRoot(
    {
      name: "embedded-app",
      runtime: 4 as const,
      provider: ProviderId.make("test"),
      services: {
        [ServiceName.make("web")]: { image: "nginx:1.27", home: false },
      },
    },
    discoveredRoot,
  );
  try {
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, slowBindCapabilities)).pipe(
        Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))),
      ),
    );

    expect(plan.root).toBe(canonicalRoot);
    expect(plan.identity?.appRoot).toBe(canonicalRoot);
    expect(plan.fileSync.length).toBeGreaterThan(0);
    for (const entry of plan.fileSync) {
      expect(entry.session.app.root).toBe(plan.root);
      expect(entry.session.source).toBe(plan.root);
    }
    const web = plan.services[ServiceName.make("web")];
    expect(web?.appMount?.source).toBe(plan.root);
    expect(
      web?.mounts.some(
        (mount) =>
          mount.type === "bind" &&
          mount.source === plan.root &&
          mount.target === PortablePath.make("/app"),
      ),
    ).toBe(true);
  } finally {
    realpath.mockRestore();
    await rm(canonicalRoot, { recursive: true, force: true });
  }
});
