import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { globalEnablementBucket } from "../../src/global-app/enablement.ts";
import { type LoadGlobalPlanResult, loadGlobalPlan } from "../../src/operations/global-plan.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const withGlobalFiles = async <A>(
  use: (fixture: {
    readonly root: string;
    readonly load: () => Promise<LoadGlobalPlanResult>;
    readonly setEnablement: (enabled: Record<string, boolean>) => Promise<void>;
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
    providerId: Effect.succeed(ProviderId.make("lando")),
    root: Effect.succeed(paths.root),
    paths: Effect.succeed(paths),
    ensureRoot: Effect.void,
    ensureUserLandofile: Effect.succeed({ path: paths.userLandofile, created: false }),
    ensureRunning: () => Effect.succeed([]),
    regenerateDist: () => Effect.succeed({ path: dist, status: "unchanged", serviceIds: [] }),
  });
  const layer = Layer.mergeAll(
    makeTestStateStore().layer,
    BunFileSystem.layer,
    Layer.succeed(GlobalAppService, globalApp),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: (plan) => {
          expect(typeof plan === "string" ? plan : plan?.provider).toBe(ProviderId.make("lando"));
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
            expect(landofile.document).toMatchObject({ name: "global", provider: "lando" });
            return {
              valueModel: 1 as const,
              id: AppId.make("global"),
              name: landofile.document.name ?? "global",
              slug: "global",
              root: AbsolutePath.make(process.cwd()),
              provider: landofile.document.provider ?? ProviderId.make("docker"),
              services: {},
              routes: [],
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
  const setEnablement = (enabled: Record<string, boolean>) =>
    Effect.runPromise(
      globalEnablementBucket().pipe(
        Effect.flatMap((bucket) => bucket.set(enabled)),
        Effect.provide(layer),
      ),
    );
  try {
    await writeFile(
      dist,
      "name: global\nruntime: 4\nservices:\n  mailpit:\n    type: lando\n    environment:\n      KEEP: generated\n      CHANGE: generated\n    command: [generated, command]\n",
    );
    return await use({ root, load, setEnablement });
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
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]).toMatchObject({
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
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
      KEEP: "generated",
    });
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.routes).toEqual([
      "global.test",
    ]);
    expect(loaded.plan.provider).toBe(ProviderId.make("lando"));
  });
});

test("global loading materializes typed sites before per-layer validation", async () => {
  // Given
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(
      join(root, ".lando.base.yml"),
      'services:\n  mailpit:\n    primary: "{{ eq(recipe.flag, false) }}"\n',
    );
    await writeFile(
      join(root, ".lando.yml"),
      [
        "recipe:",
        "  id: lamp",
        "  version: 0.1.0",
        "  options:",
        "    flag: false",
        "  producer:",
        "    sourceKind: bundled",
        '    packageName: "@lando/recipe-lamp"',
        "    recipeId: lamp",
        "    manifestVersion: 0.1.0",
        `    contentDigest: sha256:${"0".repeat(64)}`,
        "",
      ].join("\n"),
    );
    // When
    const loaded = await load();
    // Then
    if (!loaded.materialized) throw new Error("Expected global Landofile");
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.primary).toBe(true);
  });
});

test("global loading compiles typed expressions with the shared validator", async () => {
  await withGlobalFiles(async ({ root, load }) => {
    // Given
    await writeFile(join(root, ".lando.yml"), 'services:\n  web:\n    primary: "{{ eq(1, 2) }}"\n');
    // When
    const result = await load();
    // Then
    if (!result.materialized) throw new Error("Expected global Landofile");
    expect(result.landofile.document.services?.[ServiceName.make("web")]?.primary).toBe(false);
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
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
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
      expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
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
    expect(loaded.landofile.document).toMatchObject({ name: "global", provider: "lando" });
    expect(loaded.plan).toMatchObject({ name: "global", provider: "lando", root });
  });
});

for (const content of [
  "name: other\nprovider: docker\n",
  "name: !reset\nprovider: !reset\n",
  'name: "{{ env.LANDO_FORCED_NAME }}"\nprovider: "{{ env.LANDO_FORCED_PROVIDER }}"\n',
  'name: "{{ app.name }}"\nprovider: "{{ app.provider }}"\n',
]) {
  test(`drops authored identity sites before materialization: ${content.trim()}`, async () => {
    await withGlobalFiles(async ({ root, load }) => {
      await writeFile(join(root, ".lando.yml"), content);
      const result = await load();
      if (!result.materialized) throw new Error("Expected global Landofile");
      expect(result.landofile.document).toMatchObject({ name: "global", provider: "lando" });
      expect(
        result.landofile.pendingSites.some((site) => site.path[0] === "name" || site.path[0] === "provider"),
      ).toBe(false);
    });
  });
}

for (const form of [".lando.local.ts", ".lando.ts"]) {
  test(`loads the global TypeScript layer ${form} from an unrelated cwd`, async () => {
    await withGlobalFiles(async ({ root, load }) => {
      expect(process.cwd()).not.toBe(root);
      await writeFile(
        join(root, form),
        'export default { services: { mailpit: { environment: { CHANGE: "typescript" } } } };\n',
      );
      const result = await load();
      if (!result.materialized) throw new Error("Expected global Landofile");
      expect(result.landofile.document.services?.[ServiceName.make("mailpit")]?.environment?.CHANGE).toBe(
        "typescript",
      );
      expect(result.landofile.context.appRoot).toBe(AbsolutePath.make(root));
      expect(getLandofileAppRoot(result.landofile)).toBe(root);
      expect(result.plan.root).toBe(AbsolutePath.make(root));
    });
  });
}

test("rejects conflicting YAML and TypeScript forms of a global layer", async () => {
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(join(root, ".lando.local.yml"), "runtime: 4\n");
    await writeFile(join(root, ".lando.local.ts"), "export default { runtime: 4 };\n");
    await expect(load()).rejects.toMatchObject({
      _tag: "LandofileFormConflictError",
    });
  });
});

test("resolves a local include relative to the global layer", async () => {
  await withGlobalFiles(async ({ root, load }) => {
    await writeFile(
      join(root, "included.yml"),
      "services:\n  mailpit:\n    environment:\n      INCLUDED: local\n",
    );
    await writeFile(join(root, ".lando.local.ts"), 'export default { includes: ["included.yml"] };\n');
    const result = await load();
    if (!result.materialized) throw new Error("Expected global Landofile");
    expect(result.landofile.document.services?.[ServiceName.make("mailpit")]?.environment?.INCLUDED).toBe(
      "local",
    );
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
  test(`validates the effective value after composing ${name}`, async () => {
    // Given an invalid service value and a later valid override where available.
    await withGlobalFiles(async ({ root, load }) => {
      await writeFile(join(root, ".lando.user.yml"), "services:\n  mailpit:\n    home: false\n");
      const file = join(root, name);
      await writeFile(file, "services:\n  mailpit:\n    home: wrong\n");
      // When the global app loads, then only the effective value is runtime-validated.
      const result = await load().catch((error: unknown) => error);
      expect(result).toMatchObject(
        name === ".lando.user.yml"
          ? { _tag: "LandofileValidationError", file }
          : { materialized: true, landofile: { document: { services: { mailpit: { home: false } } } } },
      );
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
    expect(loaded.landofile.document.services?.[ServiceName.make("mailpit")]?.environment?.CHANGE).toBe(
      "second",
    );
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
  test(`disabled service overrides in ${name} are omitted before expression evaluation and validation`, async () => {
    await withGlobalFiles(async ({ root, load, setEnablement }) => {
      await setEnablement({ mailpit: false });
      await writeFile(
        join(root, name),
        [
          "services:",
          "  mailpit:",
          '    primary: "{{ eq(recipe.missing, true) }}"',
          "    home: invalid",
          "  custom:",
          "    type: lando",
          "    environment:",
          "      RETAIN: custom",
          "",
        ].join("\n"),
      );

      const loaded = await load();

      if (!loaded.materialized) throw new Error("Expected global Landofile");
      expect(loaded.landofile.document.services).not.toHaveProperty("mailpit");
      expect(loaded.landofile.document.services).toHaveProperty("custom.environment.RETAIN", "custom");
      expect(
        loaded.landofile.pendingSites.some(
          (site) => site.path[0] === "services" && site.path[1] === "mailpit",
        ),
      ).toBe(false);
    });
  });
}

test("disabled TypeScript include overrides stay omitted without removing authored content", async () => {
  await withGlobalFiles(async ({ root, load, setEnablement }) => {
    await setEnablement({ mailpit: false });
    await writeFile(
      join(root, "included.yml"),
      [
        "services:",
        "  mailpit:",
        '    primary: "{{ eq(recipe.missing, true) }}"',
        "    home: false",
        "  custom:",
        "    type: lando",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, ".lando.local.ts"), 'export default { includes: ["included.yml"] };\n');

    const disabled = await load();
    if (!disabled.materialized) throw new Error("Expected global Landofile");
    expect(disabled.landofile.document.services).not.toHaveProperty("mailpit");
    expect(disabled.landofile.document.services).toHaveProperty("custom");

    await setEnablement({ mailpit: true });
    await expect(load()).rejects.toMatchObject({ _tag: "ConfigExpressionError" });
  });
});

test("re-enabling restores the generated service and its preserved authored overrides", async () => {
  await withGlobalFiles(async ({ root, load, setEnablement }) => {
    await writeFile(
      join(root, ".lando.yml"),
      "services:\n  mailpit:\n    environment:\n      CHANGE: authored\n",
    );
    await setEnablement({ mailpit: false });
    const disabled = await load();
    if (!disabled.materialized) throw new Error("Expected global Landofile");
    expect(disabled.landofile.document.services).not.toHaveProperty("mailpit");

    await setEnablement({ mailpit: true });
    const enabled = await load();
    if (!enabled.materialized) throw new Error("Expected global Landofile");
    expect(enabled.landofile.document.services?.[ServiceName.make("mailpit")]?.environment).toEqual({
      KEEP: "generated",
      CHANGE: "authored",
    });
  });
});

test("service-map expressions cannot restore disabled services", async () => {
  await withGlobalFiles(async ({ root, load, setEnablement }) => {
    await setEnablement({ mailpit: false });
    await writeFile(
      join(root, ".lando.yml"),
      "services: \"{{ { mailpit: { type: 'lando' }, custom: { type: 'lando' } } }}\"\n",
    );
    const loaded = await load();
    if (!loaded.materialized) throw new Error("Expected global Landofile");
    expect(loaded.landofile.document.services).not.toHaveProperty("mailpit");
    expect(loaded.landofile.document.services).toHaveProperty("custom");
  });
});
