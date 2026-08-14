export const guideComponentVocabulary = {
  Guide: "./src/components/Guide.astro",
  Scenario: "./src/components/Scenario.astro",
  Step: "./src/components/Step.astro",
  Run: "./src/components/Run.astro",
  Verify: "./src/components/Verify.astro",
  Inspect: "./src/components/Inspect.astro",
  Hidden: "./src/components/Hidden.astro",
  Cleanup: "./src/components/Cleanup.astro",
  Variable: "./src/components/Variable.astro",
  UseFixture: "./src/components/UseFixture.astro",
  Skip: "./src/components/Skip.astro",
  Inline: "./src/components/Inline.astro",
  Tabs: "./src/components/Tabs.astro",
  Tab: "./src/components/Tab.astro",
} as const;

export const CONTEXT_COMPONENT_NAMES = [
  "Step",
  "Run",
  "Verify",
  "Inspect",
  "Cleanup",
  "Inline",
  "Tab",
] as const satisfies readonly (keyof typeof guideComponentVocabulary)[];
