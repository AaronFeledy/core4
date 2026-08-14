import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CONTEXT_COMPONENT_NAMES, guideComponentVocabulary } from "../src/components/vocabulary.ts";

const COMPONENT_NAMES = [
  "Guide",
  "Scenario",
  "Step",
  "Run",
  "Verify",
  "Inspect",
  "Hidden",
  "Cleanup",
  "Variable",
  "UseFixture",
  "Skip",
  "Inline",
  "Tabs",
  "Tab",
] as const;

const docsRoot = join(import.meta.dir, "..");

describe("guide component vocabulary", () => {
  test("maps exactly the supported component files", async () => {
    // Given: the authoritative executable-guide component names.
    const expectedNames = [...COMPONENT_NAMES].sort();

    // When: the docs vocabulary is inspected.
    const actualNames = Object.keys(guideComponentVocabulary).sort();

    // Then: every name has one matching component file and there are no extras.
    expect(actualNames).toEqual(expectedNames);
    for (const name of COMPONENT_NAMES) {
      expect(guideComponentVocabulary[name]).toBe(`./src/components/${name}.astro`);
      expect(await Bun.file(join(docsRoot, "src", "components", `${name}.astro`)).exists()).toBe(true);
    }
  });

  test("registers the vocabulary map with the auto-import integration", async () => {
    // Given: the Astro configuration source.
    const config = await Bun.file(join(docsRoot, "astro.config.mjs")).text();

    // When: integration imports and registration are inspected.
    const usesIntegration = config.includes('from "astro-auto-import"');
    const usesVocabulary = config.includes('from "./src/components/vocabulary.ts"');
    const registersMap = config.includes("imports: Object.values(guideComponentVocabulary)");

    // Then: auto-import consumes the single source-of-truth vocabulary.
    expect({ registersMap, usesIntegration, usesVocabulary }).toEqual({
      registersMap: true,
      usesIntegration: true,
      usesVocabulary: true,
    });
  });

  test("imports Starlight tab primitives in the tab wrappers", async () => {
    // Given: the Tabs and Tab wrapper sources.
    const tabs = await Bun.file(join(docsRoot, "src", "components", "Tabs.astro")).text();
    const tab = await Bun.file(join(docsRoot, "src", "components", "Tab.astro")).text();

    // When: their Starlight imports are inspected.
    // Then: the wrappers import the real Starlight components instead of relying on auto-import.
    expect(tabs).toContain('import { Tabs as StarlightTabs } from "@astrojs/starlight/components"');
    expect(tab).toContain('import { TabItem } from "@astrojs/starlight/components"');
  });

  test("CONTEXT_COMPONENT_NAMES lists exactly the remark context inject targets", async () => {
    // Given: the independent expected set of context-bearing wrappers.
    const expected = ["Step", "Run", "Verify", "Inspect", "Cleanup", "Inline", "Tab"] as const;

    // When: the shared constant is inspected.
    // Then: it matches exactly and every entry resolves to an existing vocabulary .astro file.
    expect([...CONTEXT_COMPONENT_NAMES].sort()).toEqual([...expected].sort());
    expect(CONTEXT_COMPONENT_NAMES).toHaveLength(expected.length);
    for (const name of CONTEXT_COMPONENT_NAMES) {
      expect(guideComponentVocabulary[name]).toBe(`./src/components/${name}.astro`);
      expect(await Bun.file(join(docsRoot, "src", "components", `${name}.astro`)).exists()).toBe(true);
    }
  });
});
