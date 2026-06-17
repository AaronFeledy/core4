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
  {
    specifier: "@lando/core/oclif",
    exportKey: "./oclif",
    target: "./src/cli/oclif/index.ts",
    assertSymbol: (mod: Record<string, unknown>) => expect(mod.LandoCommandBase).toBeDefined(),
  },
] as const;

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

const publishedEntryPoints = [...publicEntryPoints, ...documentedAuxiliaryEntryPoints] as const;

type EntryPoint = (typeof publishedEntryPoints)[number];

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
  test.each([...publishedEntryPoints] as EntryPoint[])(
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
