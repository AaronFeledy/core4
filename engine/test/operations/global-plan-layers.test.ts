import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { type LoadGlobalPlanResult, loadGlobalPlan } from "../../src/operations/global-plan.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const withGlobalFiles = async <A>(
  use: (fixture: {
    readonly root: string;
    readonly load: () => Promise<LoadGlobalPlanResult>;
  }) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-layers-"));
  const dist = AbsolutePath.make(join(root, ".lando.dist.yml"));
  const paths = {
    root: AbsolutePath.make(root),
    distLandofile: dist,
    userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
  };
  const globalApp = GlobalAppService.of({
    id: "global",
    root: Effect.succeed(paths.root),
    paths: Effect.succeed(paths),
    ensureRoot: Effect.void,
    ensureUserLandofile: Effect.succeed({ path: paths.userLandofile, created: false }),
    ensureRunning: () => Effect.succeed([]),
    regenerateDist: () => Effect.succeed({ path: dist, status: "unchanged", serviceIds: [] }),
  });
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    Layer.succeed(GlobalAppService, globalApp),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: (plan) => {
          expect(plan).toMatchObject({ provider: "lando" });
          return Effect.succeed(TestRuntimeProvider);
        },
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile) =>
          Effect.sync(() => {
            expect(process.cwd()).toBe(root);
            expect(landofile).toMatchObject({ name: "global", provider: "lando" });
            return {
              id: AppId.make("global"),
              name: landofile.name ?? "global",
              slug: "global",
              root: AbsolutePath.make(process.cwd()),
              provider: landofile.provider ?? ProviderId.make("docker"),
              services: {},
              routes: [],
              networks: [],
              stores: [],
              fileSync: [],
              extensions: {},
              metadata: {
                resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"),
                source: "test",
                runtime: 4,
              },
            };
          }),
      }),
    ),
  );
  const load = () => Effect.runPromise(loadGlobalPlan().pipe(Effect.provide(layer)));
  try {
    await writeFile(
      dist,
      "name: global\nruntime: 4\nservices:\n  mailpit:\n    type: lando\n    environment:\n      KEEP: generated\n      CHANGE: generated\n    command: [generated, command]\n",
    );
    return await use({ root, load });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("preserves nested generated maps when the canonical overlay replaces a command array", async () => {
  // Given a partial authored service override.
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(
      join(root, ".lando.yml"),
      "services:\n  mailpit:\n    environment:\n      CHANGE: authored\n    command: [authored]\n",
    );
    // When the global app is planned.
    const loaded = await load();
    // Then generated siblings survive and scalar arrays replace rather than append.
    expect(loaded.materialized).toBe(true);
    if (!loaded.materialized) throw new Error("expected materialized plan");
    expect(loaded.landofile.services?.[ServiceName.make("mailpit")]).toMatchObject({
      type: "lando",
      environment: { KEEP: "generated", CHANGE: "authored" },
      command: ["authored"],
    });
  });
});

test("global directives are consumed before the managed-provider plan", async () => {
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(
      join(root, ".lando.yml"),
      "provider: docker\nservices:\n  mailpit:\n    environment:\n      CHANGE: !reset\n    routes: !override\n      - global.test\n",
    );
    const loaded = await load();
    expect(loaded.materialized).toBe(true);
    if (!loaded.materialized) throw new Error("Expected a global plan.");
    expect(loaded.landofile.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
      KEEP: "generated",
    });
    expect(loaded.landofile.services?.[ServiceName.make("mailpit")]?.routes).toEqual(["global.test"]);
    expect(loaded.plan.provider).toBe(ProviderId.make("lando"));
  });
});

test("merges all six global YAML layers in low-to-high precedence", async () => {
  // Given each layer overrides the keys introduced by its predecessors.
  await withGlobalFiles(async ({ root, load }) => {
    const names = [
      ".lando.base.yml",
      ".lando.dist.yml",
      ".lando.upstream.yml",
      ".lando.yml",
      ".lando.local.yml",
      ".lando.user.yml",
    ];
    for (const [index, name] of names.entries()) {
      const environment = Array.from(
        { length: 6 - index },
        (_, key) => `      L${key + index}: layer${index}`,
      ).join("\n");
      await writeFile(join(root, name), `services:\n  mailpit:\n    environment:\n${environment}\n`);
    }
    // When the global app is planned.
    const loaded = await load();
    // Then each key reflects the highest layer that authored it.
    if (!loaded.materialized) throw new Error("expected materialized plan");
    expect(loaded.landofile.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
      L0: "layer0",
      L1: "layer1",
      L2: "layer2",
      L3: "layer3",
      L4: "layer4",
      L5: "layer5",
    });
  });
});

for (const content of [undefined, "", "# User overrides for the global Lando app.\n"]) {
  test(`preserves generated services when the overlay is ${content === undefined ? "missing" : content === "" ? "empty" : "comment-only"}`, async () => {
    // Given an absent or empty authored layer.
    await withGlobalFiles(async ({ root, load }) => {
      if (content !== undefined) await writeFile(join(root, ".lando.yml"), content);
      // When the global app is planned.
      const loaded = await load();
      // Then the generated configuration remains available.
      if (!loaded.materialized) throw new Error("expected materialized plan");
      expect(loaded.landofile.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
        KEEP: "generated",
        CHANGE: "generated",
      });
    });
  });
}

for (const [content, tag, pathKey] of [
  ["services:\n  broken line\n", "LandofileParseError", "filePath"],
  ["unsupported: true\n", "LandofileValidationError", "file"],
  ["services:\n  mailpit:\n    home: wrong\n", "LandofileValidationError", "file"],
] as const) {
  test(`attributes ${tag} to the invalid canonical layer`, async () => {
    // Given invalid authored YAML or schema content.
    await withGlobalFiles(async ({ root, load }) => {
      const file = join(root, ".lando.yml");
      await writeFile(file, content);
      // When the global app loads, then it rejects with the actual source path.
      const result = await load().catch((error: unknown) => error);
      expect(result).toMatchObject({ _tag: tag, [pathKey]: file });
    });
  });
}

test("pins reserved global identity and provider when an authored layer changes them", async () => {
  // Given authored identity and provider values that differ from the managed values.
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(join(root, ".lando.yml"), "name: authored\nprovider: docker\n");
    // When the global app is planned.
    const loaded = await load();
    // Then both the effective Landofile and plan keep their global identity.
    if (!loaded.materialized) throw new Error("expected materialized plan");
    expect(loaded.landofile).toMatchObject({ name: "global", provider: "lando" });
    expect(loaded.plan).toMatchObject({ name: "global", provider: "lando", root });
  });
});

for (const name of [
  ".lando.base.yml",
  ".lando.dist.yml",
  ".lando.upstream.yml",
  ".lando.yml",
  ".lando.local.yml",
  ".lando.user.yml",
]) {
  test(`strictly validates ${name} before merging later valid overrides`, async () => {
    // Given an invalid service value and a later valid override where available.
    await withGlobalFiles(async ({ root, load }) => {
      await writeFile(join(root, ".lando.user.yml"), "services:\n  mailpit:\n    home: false\n");
      const file = join(root, name);
      await writeFile(file, "services:\n  mailpit:\n    home: wrong\n");
      // When the global app loads, then the invalid layer cannot be hidden by merging.
      const result = await load().catch((error: unknown) => error);
      expect(result).toMatchObject({ _tag: "LandofileValidationError", file });
    });
  });
}

test("keeps dist existence as the materialization gate despite authored layers", async () => {
  // Given authored content without a generated global app.
  await withGlobalFiles(async ({ root, load }) => {
    await rm(join(root, ".lando.dist.yml"));
    await writeFile(join(root, ".lando.yml"), "unsupported: true\n");
    // When the global app loads, then it is unmaterialized without parsing overlays.
    expect(await load()).toMatchObject({ materialized: false, paths: { root } });
  });
});

test("reads edited overlay content on repeated global loads", async () => {
  // Given a previously loaded authored overlay.
  await withGlobalFiles(async ({ root, load }) => {
    const file = join(root, ".lando.yml");
    await writeFile(file, "services:\n  mailpit:\n    environment:\n      CHANGE: first\n");
    await load();
    await writeFile(file, "services:\n  mailpit:\n    environment:\n      CHANGE: second\n");
    // When a subsequent load is performed.
    const loaded = await load();
    // Then it sees the new authored content.
    if (!loaded.materialized) throw new Error("expected materialized plan");
    expect(loaded.landofile.services?.[ServiceName.make("mailpit")]?.environment?.CHANGE).toBe("second");
  });
});
