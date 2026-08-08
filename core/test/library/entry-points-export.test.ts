import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");

const publicEntryPoints = [
  {
    specifier: "@lando/core",
    exportKey: ".",
    target: "./src/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.makeLandoRuntime).toBeFunction(),
  },
  {
    specifier: "@lando/core/schema",
    exportKey: "./schema",
    target: "./src/schema/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => {
      expect(mod.GlobalConfig).toBeDefined();
      expect(mod.UpdateManifestSchema).toBeDefined();
    },
  },
  {
    specifier: "@lando/core/errors",
    exportKey: "./errors",
    target: "./src/errors/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.ConfigError).toBeDefined(),
  },
  {
    specifier: "@lando/core/events",
    exportKey: "./events",
    target: "./src/lifecycle/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.EventService).toBeDefined(),
  },
  {
    specifier: "@lando/core/services",
    exportKey: "./services",
    target: "./src/services/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.RuntimeProvider).toBeDefined(),
  },
  {
    specifier: "@lando/core/paths",
    exportKey: "./paths",
    target: "./src/config/paths.ts",
    assertSymbol: (mod: Record<string, unknown>) => {
      expect(mod.resolveLandoRoots).toBeFunction();
      expect(mod.makeLandoPaths).toBeFunction();
      expect(mod.normalizeHostPlatform).toBeFunction();
    },
  },
  {
    specifier: "@lando/core/testing",
    exportKey: "./testing",
    target: "./src/testing/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.TestRuntimeProvider).toBeDefined(),
  },
  {
    specifier: "@lando/core/cli",
    exportKey: "./cli",
    target: "./src/cli/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.runCli).toBeFunction(),
  },
] as const;

const removedPackageEntryPoints = [{ specifier: "@lando/core/oclif", exportKey: "./oclif" }] as const;

const embeddingDocPaths = ["docs/embedding.md", "docs/guides/library/embedding-defaults.mdx"] as const;

const documentedAuxiliaryEntryPoints = [
  {
    specifier: "@lando/core/docs/components",
    exportKey: "./docs/components",
    target: "./src/docs/components/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.GuideFrontmatter).toBeDefined(),
  },
  {
    specifier: "@lando/core/docs/render",
    exportKey: "./docs/render",
    target: "./src/docs/render/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.renderPublicTranscriptHtml).toBeFunction(),
  },
  {
    specifier: "@lando/core/docs/redactions",
    exportKey: "./docs/redactions",
    target: "./src/docs/render/redaction.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.redactPublicTranscript).toBeFunction(),
  },
  {
    specifier: "@lando/core/cli/operations",
    exportKey: "./cli/operations",
    target: "./src/cli/operations.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.invokeOperation).toBeFunction(),
  },
] as const;

/** Package re-export seams covered by resolve inventory but not embedding docs. */
const reExportEntryPoints = [
  {
    specifier: "@lando/core/secrets",
    exportKey: "./secrets",
    target: "./src/secrets/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => {
      expect(mod.createRedactor).toBeFunction();
      expect(mod.createSecretRedactor).toBeFunction();
      expect(mod.REDACTED).toBeDefined();
    },
  },
  {
    specifier: "@lando/core/landofile",
    exportKey: "./landofile",
    target: "./src/landofile/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => {
      expect(mod.emitLandofileYaml).toBeFunction();
      expect(mod.parseLandofile).toBeFunction();
    },
  },
] as const;

const publishedEntryPoints = [...publicEntryPoints, ...documentedAuxiliaryEntryPoints] as const;

const resolveEntryPoints = [...publishedEntryPoints, ...reExportEntryPoints] as const;

type EntryPoint = (typeof resolveEntryPoints)[number];

const getExportTarget = (entry: EntryPoint): { readonly types: string; readonly import: string } => {
  const value = corePackage.exports[entry.exportKey as keyof typeof corePackage.exports];
  expect(value).toEqual({ types: entry.target, import: entry.target });
  if (typeof value !== "object" || value === null || !("types" in value) || !("import" in value)) {
    throw new Error(`${entry.exportKey} must declare explicit types/import package export targets`);
  }

  const typedValue = value as { readonly types: unknown; readonly import: unknown };
  if (typeof typedValue.types !== "string" || typeof typedValue.import !== "string") {
    throw new Error(`${entry.exportKey} package export targets must be strings`);
  }

  return { types: typedValue.types, import: typedValue.import };
};

describe("@lando/core public package entry points", () => {
  test("resolve inventory covers every package.json#exports key", () => {
    // Given: the package exports map and the resolve-inventory export keys
    const packageExportKeys: readonly string[] = Object.keys(corePackage.exports).toSorted();
    const resolveInventoryKeys: readonly string[] = resolveEntryPoints
      .map((entry) => entry.exportKey)
      .toSorted();

    // When: comparing the two key sets
    // Then: every package export is present in the resolve inventory
    expect(resolveInventoryKeys).toEqual(packageExportKeys);
  });

  test.each([...resolveEntryPoints] as EntryPoint[])(
    "$specifier exposes explicit TS types and ESM import target",
    async (entry) => {
      const target = getExportTarget(entry);
      expect(target.types).toBe(entry.target);
      expect(target.import).toBe(entry.target);

      const mod = await import(entry.specifier);
      entry.assertSymbol(mod);

      expect(await realpath(Bun.resolveSync(entry.specifier, repoRoot))).toBe(
        await realpath(join(coreRoot, target.import.slice("./".length))),
      );
    },
  );

  test("embedding documentation names every published library entry point", async () => {
    const docs = await Bun.file(resolve(repoRoot, "docs/embedding.md")).text();
    const documentedEntryPoints = new Set(
      [...docs.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(([, specifier]) => specifier),
    );

    for (const entry of publishedEntryPoints) {
      expect(documentedEntryPoints).toContain(entry.specifier);
    }
  });
});

describe("@lando/core removed package entry points", () => {
  for (const entry of removedPackageEntryPoints) {
    test(`${entry.exportKey} is absent from the exports map`, () => {
      expect(Object.keys(corePackage.exports)).not.toContain(entry.exportKey);
    });

    test(`${entry.specifier} fails package-specifier resolution`, () => {
      expect(() => Bun.resolveSync(entry.specifier, repoRoot)).toThrow();
    });

    test(`${entry.specifier} rejects dynamic import`, async () => {
      const specifier: string = entry.specifier;
      const rejected = await import(specifier).then(
        () => false,
        () => true,
      );
      expect(rejected).toBe(true);
    });
  }

  test("deep file paths do not bypass the exports map", () => {
    expect(() => Bun.resolveSync("@lando/core/src/cli/oclif/index.ts", repoRoot)).toThrow();
  });

  test("the legacy-named native metadata adapter remains available by source path", async () => {
    const mod = await import("../../src/cli/oclif/index.ts");
    expect(mod.LandoCommandBase).toBeDefined();
  });

  test("@lando/core/cli remains exported and importable", async () => {
    expect(Object.keys(corePackage.exports)).toContain("./cli");
    expect(await realpath(Bun.resolveSync("@lando/core/cli", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/cli/index.ts")),
    );
    expect((await import("@lando/core/cli")).runCli).toBeFunction();
  });

  for (const docPath of embeddingDocPaths) {
    test(`${docPath} does not advertise a removed entry point`, async () => {
      const docs = await Bun.file(resolve(repoRoot, docPath)).text();
      for (const entry of removedPackageEntryPoints) expect(docs).not.toContain(entry.specifier);
    });
  }
});
