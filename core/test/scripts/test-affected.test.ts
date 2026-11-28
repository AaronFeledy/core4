import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverChanges } from "../../../scripts/git-changes.ts";
import {
  affectedGuideRunPlan,
  notExecutedReason,
  summarizeAffectedGuides,
} from "../../../scripts/guides/affected-guide-run.ts";
import { selectAffectedGuides } from "../../../scripts/guides/affected-guides.ts";
import type { HomeGuideEntry } from "../../../scripts/guides/home-guide-registry.ts";
import {
  affectedRunOutcome,
  affectedTestCommand,
  nothingExecutedReport,
  unitTestEnvironment,
} from "../../../scripts/test-affected-run.ts";
import { selectAffectedTests } from "../../../scripts/test-affected-selection.ts";
import { collectShardedTestFiles } from "../../../scripts/test-shards.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const put = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const git = async (root: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return out;
};

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "test-affected-"));
  roots.push(root);
  await put(root, "package.json", JSON.stringify({ workspaces: ["pkg", "lib"] }));
  await put(
    root,
    "pkg/package.json",
    JSON.stringify({ name: "@demo/pkg", exports: { ".": "./src/index.ts" } }),
  );
  await put(
    root,
    "lib/package.json",
    JSON.stringify({ name: "@demo/lib", exports: { "./feature": "./src/feature.ts" } }),
  );
  await git(root, "init", "-q");
  return root;
};

test("normalizes backslashes before enforcing repository path containment", async () => {
  const root = await fixture();
  await expect(
    selectAffectedTests({
      root,
      changed: ["nested\\..\\..\\outside.ts"],
      eligible: [],
    }),
  ).rejects.toThrow("path must be a file inside the repository");
  const valid = await selectAffectedTests({
    root,
    changed: ["pkg\\src\\leaf.ts"],
    eligible: [],
  });
  expect(valid.changed).toEqual(["pkg/src/leaf.ts"]);
});

test("selects through re-exports, named workspace exports, type imports, and static calls", async () => {
  const root = await fixture();
  await put(root, "pkg/test/a.test.ts", 'import "../src/barrel";\n');
  await put(root, "pkg/src/barrel.ts", 'export * from "@demo/lib/feature";\n');
  await put(root, "lib/src/feature.ts", 'import type { Leaf } from "./leaf";\n');
  await put(root, "lib/src/leaf.ts", "export type Leaf = string;\n");
  await put(root, "pkg/test/b.test.ts", 'const target = "../src/call"; require(target);\n');
  await put(root, "pkg/src/call.ts", 'const target = "@demo/lib/feature"; void import(target);\n');
  await put(root, "pkg/test/other.test.ts", 'import "../src/unrelated";\n');
  await put(root, "pkg/src/unrelated.ts", "export {};\n");

  const result = await selectAffectedTests({
    root,
    changed: ["lib/src/leaf.ts"],
    eligible: ["pkg/test/a.test.ts", "pkg/test/b.test.ts", "pkg/test/other.test.ts"],
  });
  expect(result.selected).toEqual(["pkg/test/a.test.ts", "pkg/test/b.test.ts"]);
  expect(result.sharedPreloadTests).toEqual([]);
  expect(result.witnesses.get("pkg/test/a.test.ts")).toEqual([
    "lib/src/leaf.ts",
    "lib/src/feature.ts",
    "pkg/src/barrel.ts",
    "pkg/test/a.test.ts",
  ]);
  expect(result.uncertain.some((entry) => entry.includes("computed import/require"))).toBe(true);
});

test("follows static and dynamic imports through package files outside src and test", async () => {
  const root = await fixture();
  await put(root, "pkg/test/a.test.ts", 'import "../bin/bridge";\n');
  await put(root, "pkg/bin/bridge.ts", 'export * from "../src/leaf";\n');
  await put(root, "pkg/test/b.test.ts", 'import "../tools/dynamic";\n');
  await put(root, "pkg/tools/dynamic.ts", 'const target = "../src/leaf"; void import(target);\n');
  await put(root, "pkg/src/leaf.ts", "export const leaf = 1;\n");
  const result = await selectAffectedTests({
    root,
    changed: ["pkg/src/leaf.ts"],
    eligible: ["pkg/test/a.test.ts", "pkg/test/b.test.ts"],
  });
  expect(result.selected).toEqual(["pkg/test/a.test.ts", "pkg/test/b.test.ts"]);
  expect(result.witnesses.get("pkg/test/a.test.ts")).toEqual([
    "pkg/src/leaf.ts",
    "pkg/bin/bridge.ts",
    "pkg/test/a.test.ts",
  ]);
  expect(result.witnesses.get("pkg/test/b.test.ts")).toEqual([
    "pkg/src/leaf.ts",
    "pkg/tools/dynamic.ts",
    "pkg/test/b.test.ts",
  ]);
});

test("selects tests through configured preload imports", async () => {
  const root = await fixture();
  await put(root, "bunfig.toml", '[test]\npreload = ["./pkg/preload.ts"]\n');
  await put(root, "pkg/preload.ts", 'import "./preload-helper";\n');
  await put(root, "pkg/preload-helper.ts", 'import "./src/leaf";\n');
  await put(root, "pkg/src/leaf.ts", "export const leaf = 1;\n");
  await put(root, "pkg/test/a.test.ts", "export {};\n");
  await put(root, "pkg/test/b.test.ts", "export {};\n");
  const result = await selectAffectedTests({
    root,
    changed: ["pkg/src/leaf.ts"],
    eligible: ["pkg/test/a.test.ts", "pkg/test/b.test.ts"],
  });
  expect(result.selected).toEqual(["pkg/test/a.test.ts", "pkg/test/b.test.ts"]);
  expect(result.sharedPreloadTests).toEqual(["pkg/test/a.test.ts", "pkg/test/b.test.ts"]);
  expect(result.witnesses.get("pkg/test/a.test.ts")).toEqual([
    "pkg/src/leaf.ts",
    "pkg/preload-helper.ts",
    "pkg/preload.ts",
    "pkg/test/a.test.ts",
  ]);
});

test("attributes a lazy preload load to readers of the global that triggers it", async () => {
  const root = await fixture();
  await put(root, "bunfig.toml", '[test]\npreload = ["./pkg/preload.ts"]\n');
  const preload = (target: string) =>
    [
      'const key = "__demoState";',
      "let state: object | undefined;",
      'const load = (): object => (state ??= require("./src/plugins"));',
      `const lazy = new Proxy(${target}, { get: (_target, name) => Reflect.get(load(), name) });`,
      "Reflect.set(globalThis, key, lazy);",
    ].join("\n");
  await put(root, "pkg/preload.ts", preload("{}"));
  await put(root, "pkg/src/plugins.ts", 'export const plugins = ["one"];\n');
  await put(root, "pkg/src/state.ts", "export const readState = () => globalThis.__demoState;\n");
  await put(root, "pkg/test/reader.test.ts", 'import "../src/state";\n');
  await put(
    root,
    "pkg/test/raw.test.ts",
    'const name = process.argv[2] ?? "";\nReflect.get(globalThis, name);\n',
  );
  await put(root, "pkg/test/direct.test.ts", 'import "../src/plugins";\n');
  await put(root, "pkg/test/other.test.ts", "export {};\n");
  const eligible = [
    "pkg/test/direct.test.ts",
    "pkg/test/other.test.ts",
    "pkg/test/raw.test.ts",
    "pkg/test/reader.test.ts",
  ];
  const result = await selectAffectedTests({ root, changed: ["pkg/src/plugins.ts"], eligible });
  expect(result.selected).toEqual([
    "pkg/test/direct.test.ts",
    "pkg/test/raw.test.ts",
    "pkg/test/reader.test.ts",
  ]);
  expect(result.preloadGlobalTests).toEqual(["pkg/test/raw.test.ts", "pkg/test/reader.test.ts"]);
  expect(result.sharedPreloadTests).toEqual([]);
  expect(result.witnesses.get("pkg/test/reader.test.ts")).toEqual([
    "pkg/src/plugins.ts",
    "pkg/src/state.ts",
    "pkg/test/reader.test.ts",
  ]);

  // A loader the preload also calls while it loads is eager, so every test depends on it.
  await put(root, "pkg/preload.ts", preload("load()"));
  const eager = await selectAffectedTests({ root, changed: ["pkg/src/plugins.ts"], eligible });
  expect(eager.selected).toEqual(eligible);
  expect(eager.sharedPreloadTests).toEqual([
    "pkg/test/other.test.ts",
    "pkg/test/raw.test.ts",
    "pkg/test/reader.test.ts",
  ]);
});

test("follows source entries a test names as literals, such as a CLI it spawns", async () => {
  const root = await fixture();
  await put(root, "pkg/bin/cli.ts", 'import "../src/leaf";\n');
  await put(root, "pkg/src/leaf.ts", "export const leaf = 1;\n");
  await put(root, "pkg/src/spawner.ts", 'export const entry = "pkg/bin/cli.ts";\n');
  await put(root, "pkg/test/root.test.ts", 'Bun.spawn([process.execPath, join(root, "pkg/bin/cli.ts")]);\n');
  await put(root, "pkg/test/relative.test.ts", 'new URL("../bin/cli.ts", import.meta.url);\n');
  await put(root, "pkg/test/template.test.ts", "const entry = `${root}/pkg/bin/cli.ts`;\n");
  await put(root, "pkg/test/segments.test.ts", 'join(root, "pkg", "bin", "cli.ts");\n');
  await put(root, "pkg/test/production.test.ts", 'import "../src/spawner";\n');
  const result = await selectAffectedTests({
    root,
    changed: ["pkg/src/leaf.ts"],
    eligible: [
      "pkg/test/production.test.ts",
      "pkg/test/relative.test.ts",
      "pkg/test/root.test.ts",
      "pkg/test/segments.test.ts",
      "pkg/test/template.test.ts",
    ],
  });
  expect(result.selected).toEqual([
    "pkg/test/relative.test.ts",
    "pkg/test/root.test.ts",
    "pkg/test/segments.test.ts",
    "pkg/test/template.test.ts",
  ]);
  expect(result.witnesses.get("pkg/test/root.test.ts")).toEqual([
    "pkg/src/leaf.ts",
    "pkg/bin/cli.ts",
    "pkg/test/root.test.ts",
  ]);
});

test("resolves data imports as leaf edges", async () => {
  const root = await fixture();
  await put(
    root,
    "pkg/test/a.test.ts",
    'import data from "../data/data.json" with { type: "json" };\nvoid data;\n',
  );
  await put(root, "pkg/data/data.json", "{}\n");
  await put(root, "pkg/test/b.test.ts", "export {};\n");
  const result = await selectAffectedTests({
    root,
    changed: ["pkg/data/data.json"],
    eligible: ["pkg/test/a.test.ts", "pkg/test/b.test.ts"],
  });
  expect(result.selected).toEqual(["pkg/test/a.test.ts"]);
  expect(result.fixtureTests).toEqual([]);
  expect(result.uncertain.filter((entry) => entry.includes("unresolved local module"))).toEqual([]);
});

test("broadly selects when a configured preload cannot be statically resolved", async () => {
  for (const preload of ['["../outside.ts"]', '["./pkg/preload-${name}.ts"]', "17"]) {
    const root = await fixture();
    await put(root, "bunfig.toml", `[test]\npreload = ${preload}\n`);
    await put(root, "pkg/test/a.test.ts", "export {};\n");
    await put(root, "pkg/test/b.test.ts", "export {};\n");
    const result = await selectAffectedTests({
      root,
      changed: ["pkg/src/leaf.ts"],
      eligible: ["pkg/test/a.test.ts", "pkg/test/b.test.ts"],
    });
    expect(result.selected).toEqual(["pkg/test/a.test.ts", "pkg/test/b.test.ts"]);
    expect(result.witnesses.get("pkg/test/a.test.ts")?.[0]).toBe("bunfig.toml");
    expect(result.broadReason).toContain("preload");
    expect(result.uncertain.some((entry) => entry.includes("preload"))).toBe(true);
  }
});

test("recovers removed barrel edges and deleted paths from the base commit", async () => {
  const root = await fixture();
  await put(root, "pkg/test/a.test.ts", 'import "../src/zbarrel";\n');
  await put(root, "pkg/src/zbarrel.ts", 'export * from "./old";\n');
  await put(root, "pkg/src/old.ts", "export const old = 1;\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  await put(root, "pkg/src/zbarrel.ts", 'export * from "./znew";\n');
  await put(root, "pkg/src/znew.ts", "export const fresh = 1;\n");
  await rm(join(root, "pkg/src/old.ts"));
  const changed = (await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths;
  expect(changed).toEqual(["pkg/src/old.ts", "pkg/src/zbarrel.ts", "pkg/src/znew.ts"]);
  const result = await selectAffectedTests({
    root,
    changed,
    eligible: ["pkg/test/a.test.ts"],
    baseRef: "HEAD",
  });
  expect(result.selected).toEqual(["pkg/test/a.test.ts"]);
  expect(result.unmatched).toEqual([]);
  expect(result.priorTests).toEqual(["pkg/test/a.test.ts"]);
  const onlyDeleted = await selectAffectedTests({
    root,
    changed: ["pkg/src/old.ts"],
    eligible: ["pkg/test/a.test.ts"],
    baseRef: "HEAD",
  });
  expect(onlyDeleted.selected).toEqual([]);
  expect(onlyDeleted.unmatched).toEqual(["pkg/src/old.ts"]);
  expect(onlyDeleted.uncertain.some((entry) => entry.includes("omitted rewritten importers"))).toBe(true);
});

test("uses fixture references in imported helpers for sibling include files", async () => {
  const root = await fixture();
  await put(root, "pkg/test/fixture.test.ts", 'import "./helper";\n');
  await put(root, "pkg/test/helper.ts", 'new Bun.Glob("docs/guides/**/fixtures/**/.lando.yml");\n');
  await put(root, "pkg/test/unrelated.test.ts", "export {};\n");
  const result = await selectAffectedTests({
    root,
    changed: ["docs/guides/example/fixtures/demo/.lando.tasks.yml"],
    eligible: ["pkg/test/fixture.test.ts", "pkg/test/unrelated.test.ts"],
  });
  expect(result.selected).toEqual(["pkg/test/fixture.test.ts"]);
  expect(result.fixtureTests).toEqual(["pkg/test/fixture.test.ts"]);
  expect(result.unmatched).toEqual([]);
});

test("reports shadowed computed calls as uncertain, with stable zero selection", async () => {
  const root = await fixture();
  await put(
    root,
    "pkg/test/a.test.ts",
    'const target = "./known"; function f(target: string) { return import(target); }\n',
  );
  await put(root, "pkg/test/known.ts", "export {};\n");
  const result = await selectAffectedTests({
    root,
    changed: ["pkg/src/unused.ts"],
    eligible: ["pkg/test/a.test.ts"],
  });
  expect(result.selected).toEqual([]);
  expect(result.unmatched).toEqual(["pkg/src/unused.ts"]);
  expect(result.uncertain).toContain("pkg/test/a.test.ts:1: computed import/require");
});

test("forms exact test paths for Bun so similarly named suites cannot match", () => {
  expect(affectedTestCommand(["pkg/test/one.test.ts"]).slice(-1)).toEqual(["./pkg/test/one.test.ts"]);
});

test("reports unresolved workspace exports", async () => {
  const root = await fixture();
  await put(root, "pkg/test/a.test.ts", 'import "@demo/lib/missing";\n');
  const result = await selectAffectedTests({
    root,
    changed: ["lib/src/feature.ts"],
    eligible: ["pkg/test/a.test.ts"],
  });
  expect(result.uncertain).toContain("pkg/test/a.test.ts:1: unresolved workspace export @demo/lib/missing");
});

test("runs only exact selected paths and preserves a failing child exit", async () => {
  const root = await fixture();
  await put(root, "pkg/test/one.test.ts", 'import { test } from "bun:test"; test("one", () => {});\n');
  await put(
    root,
    "pkg/test/one-extra.test.ts",
    'import { test } from "bun:test"; test("extra", () => { throw new Error("extra ran"); });\n',
  );
  const run = async (path: string): Promise<{ code: number; stderr: string }> => {
    const child = Bun.spawn([...affectedTestCommand([path])], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { code, stderr };
  };
  const pass = await run("pkg/test/one.test.ts");
  expect(pass.code).toBe(0);
  expect(pass.stderr).toContain("1 pass");
  expect(pass.stderr).not.toContain("extra ran");
  const fail = await run("pkg/test/one-extra.test.ts");
  expect(fail.code).not.toBe(0);
  expect(fail.stderr).toContain("extra ran");
});

test(
  "finds the historical schema regressions in the current repository",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const expected = [
      "engine/test/services/landofile.test.ts",
      "landofile/test/pipeline/golden-corpus.test.ts",
      "sdk/test/schema/json-schema-authoring.test.ts",
      "sdk/test/schema/landofile-parity.test.ts",
    ];
    const result = await selectAffectedTests({
      root,
      changed: ["sdk/src/schema/landofile.ts", "sdk/src/schema/json-schema.ts"],
      eligible: expected,
    });
    expect(result.selected).toEqual(expected);
    expect(result.fixtureTests).toEqual([]);
    expect(result.unmatched).toEqual([]);
  },
  { timeout: 20_000 },
);

test(
  "finds the historical fixture and digest regressions",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const eligible = [
      "landofile/test/pipeline/golden-corpus.test.ts",
      "sdk/test/schema/landofile-parity.test.ts",
    ];
    const fixtureResult = await selectAffectedTests({
      root,
      changed: ["docs/guides/flags-and-args/fixtures/flags-demo/.lando.tasks.yml"],
      eligible,
    });
    expect(fixtureResult.selected).toEqual(eligible);
    expect(fixtureResult.fixtureTests).toEqual(eligible);
    const digestResult = await selectAffectedTests({
      root,
      changed: ["landofile/test/fixtures/golden-corpus-digests.json"],
      eligible,
    });
    expect(digestResult.selected).toContain("landofile/test/pipeline/golden-corpus.test.ts");
  },
  { timeout: 20_000 },
);

test(
  "attributes bundled plugins to composition readers instead of every test",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const reader = "engine/test/operations/app-config-candidate.test.ts";
    const direct = "plugins/renderer-lando/test/plugin-descriptor.test.ts";
    const unrelated = "paths/test/containment.test.ts";
    const result = await selectAffectedTests({
      root,
      changed: ["plugins/renderer-lando/src/index.ts"],
      eligible: [reader, direct, unrelated],
    });
    expect(result.selected).toEqual([reader, direct]);
    expect(result.preloadGlobalTests).toEqual([reader]);
    expect(result.sharedPreloadTests).toEqual([]);
  },
  { timeout: 20_000 },
);

test(
  "selects every canonical eligible test for the repository preload roots",
  async () => {
    const eligible = await collectShardedTestFiles();
    const result = await selectAffectedTests({
      root: resolve(import.meta.dirname, "../../.."),
      changed: ["scripts/test-preload-roots.ts"],
      eligible,
    });
    expect(result.selected).toEqual(eligible);
    // A test that names the preload file, or imports a runner that does, keeps that import witness.
    const preloads = ["scripts/test-preload.ts", "scripts/test-preload-teardown.ts"];
    const viaPreload = eligible.filter((test) => preloads.includes(result.witnesses.get(test)?.[1] ?? ""));
    expect(result.sharedPreloadTests).toEqual(viaPreload);
    expect(result.unmatched).toEqual([]);
  },
  { timeout: 20_000 },
);

const guideFile = (id: string, scenarios: string): string => `---
id: ${id}
provider: test
platforms: [darwin, linux, win32]
---

# ${id}

<Guide>
${scenarios}
</Guide>
`;

const step = (name: string): string =>
  `  <Step name="${name}">
    <Run command="version" />
  </Step>`;

const scenario = (id: string, props = ""): string =>
  `  <Scenario id="${id}"${props}>
${step("run")}
  </Scenario>`;

const guideRepository = async (): Promise<string> => {
  const root = await fixture();
  await put(
    root,
    "docs/guides/demo.mdx",
    guideFile(
      "demo",
      [
        scenario("runs"),
        scenario("darwin-only", ' platforms={["darwin"]}'),
        scenario("live", ' layer="e2e"'),
        `  <Scenario id="authored-skip">
    <Skip reason="never runs against the provider">
${step("run")}
    </Skip>
  </Scenario>`,
      ].join("\n"),
    ),
  );
  await put(
    root,
    "docs/guides/variant-demo.mdx",
    `---
id: variant-demo
provider: test
axes:
  mode: [one, two]
variants:
  two:
    skip:
      reason: this cell is not supported yet
---

<Guide>
  <Scenario id="modes">
    <Tabs axis="mode">
      <Tab name="one">
${step("run")}
      </Tab>
      <Tab name="two">
${step("run")}
      </Tab>
    </Tabs>
  </Scenario>
</Guide>
`,
  );
  await put(root, "docs/guides/live-demo.mdx", guideFile("live-demo", scenario("live", ' layer="e2e"')));
  await put(root, "docs/guides/demo/fixtures/app/.lando.yml", "name: demo\n");
  await put(root, "docs/guides/demo/cases.cases.ts", "export const cases = [];\n");
  await put(root, "pkg/src/covered.ts", "export const covered = 1;\n");
  await put(root, "pkg/src/uncovered.ts", "export const uncovered = 1;\n");
  await put(root, "pkg/src/live.ts", "export const live = 1;\n");
  await put(root, "pkg/test/covered.test.ts", 'import "../src/covered";\n');
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  return root;
};

const demoEntries: readonly HomeGuideEntry[] = [
  { feature: "demo", guide: "docs/guides/demo.mdx", sources: ["pkg/src/covered.ts"] },
  { feature: "variant-demo", guide: "docs/guides/variant-demo.mdx", sources: ["pkg/src/uncovered.ts"] },
  { feature: "live-demo", guide: "docs/guides/live-demo.mdx", sources: ["pkg/src/live.ts"] },
];

const guideIdsFor = async (root: string, changed: readonly string[]): Promise<readonly string[]> => {
  const selection = await selectAffectedGuides({
    root,
    changed,
    hostPlatform: "linux",
    entries: demoEntries,
  });
  expect(selection.diagnostics).toEqual([]);
  return selection.guides.map((guide) => guide.guideId);
};

test("a covered source, a guide page, and a fixture each select their guide", async () => {
  const root = await guideRepository();
  expect(await guideIdsFor(root, ["pkg/src/covered.ts"])).toEqual(["demo"]);
  expect(await guideIdsFor(root, ["docs/guides/variant-demo.mdx"])).toEqual(["variant-demo"]);
  expect(await guideIdsFor(root, ["docs/guides/demo/fixtures/app/.lando.yml"])).toEqual(["demo"]);
});

test("a case file and an uncovered source select no guide", async () => {
  const root = await guideRepository();
  expect(await guideIdsFor(root, ["docs/guides/demo/cases.cases.ts"])).toEqual([]);
  expect(await guideIdsFor(root, ["pkg/src/not-covered-anywhere.ts"])).toEqual([]);
});

test("guide selection leaves the unit selection unchanged", async () => {
  const root = await guideRepository();
  const eligible = ["pkg/test/covered.test.ts"];
  const unit = await selectAffectedTests({ root, changed: ["pkg/src/covered.ts"], eligible });
  const withGuide = await selectAffectedTests({
    root,
    changed: ["pkg/src/covered.ts", "docs/guides/demo.mdx"],
    eligible,
  });
  expect(withGuide.selected).toEqual(unit.selected);
  expect(withGuide.witnesses.get("pkg/test/covered.test.ts")).toEqual(
    unit.witnesses.get("pkg/test/covered.test.ts"),
  );
});

test("lists each variant with the compiler's skip kind for this host", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts", "pkg/src/uncovered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {});
  const byScenario = (guideId: string) =>
    new Map(
      plan.guides
        .find((guide) => guide.guideId === guideId)
        ?.variants.map((variant) => [
          variant.label === "" ? variant.scenarioId : `${variant.scenarioId} ${variant.label}`,
          variant,
        ]),
    );
  const demo = byScenario("demo");
  expect(demo.get("runs")?.state).toBe("will-run");
  expect(demo.get("darwin-only")?.skip?.kind).toBe("platform");
  expect(demo.get("authored-skip")?.skip?.kind).toBe("authored");
  expect(demo.get("live")?.state).toBe("e2e-not-admitted");
  expect(demo.size).toBe(4);

  const variant = byScenario("variant-demo");
  expect(variant.size).toBe(2);
  expect(variant.get("modes mode=one")?.state).toBe("will-run");
  expect(variant.get("modes mode=two")?.skip?.kind).toBe("variant");
});

test("e2e variants count as not admitted until the caller sets LANDO_GUIDE_E2E=1", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const notAdmitted = summarizeAffectedGuides(selection, {});
  expect(notAdmitted.e2eNotAdmitted).toBe(1);
  expect(notAdmitted.willRun).toBe(1);
  expect(notAdmitted.skipped).toBe(2);

  const admitted = summarizeAffectedGuides(selection, { LANDO_GUIDE_E2E: "1" });
  expect(admitted.e2eNotAdmitted).toBe(0);
  expect(admitted.willRun).toBe(2);
});

test("an e2e-only selection has no guide command until the caller admits e2e", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/live.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });

  const notAdmitted = affectedGuideRunPlan(selection, {});
  expect(notAdmitted.summary.willRun).toBe(0);
  expect(notAdmitted.command).toBeUndefined();
  expect(notAdmitted.e2eCommand).toContain("docs/guides/live-demo.mdx");
  expect(notAdmitted.notRun).toContain("1 e2e variant in docs/guides/live-demo.mdx (not admitted)");
  expect(affectedRunOutcome(notAdmitted, false)).toBe(1);
  expect(affectedRunOutcome(notAdmitted, true)).toBe(0);
  const report = nothingExecutedReport(notAdmitted);
  expect(report[0]).toBe(
    "[test-affected] nothing was executed: 1 e2e variant is not admitted (set LANDO_GUIDE_E2E=1 with LANDO_SCENARIO_E2E_BINARY and LANDO_TEST_PODMAN_SOCKET).",
  );
  expect(report[1]).toContain(
    "LANDO_GUIDE_E2E=1 LANDO_SCENARIO_E2E_BINARY=core/dist/lando LANDO_TEST_PODMAN_SOCKET=/path/to/podman.sock bun run dev:guides docs/guides/live-demo.mdx --once",
  );
  expect(report).toHaveLength(4);

  const admitted = affectedGuideRunPlan(selection, { LANDO_GUIDE_E2E: "1" });
  expect(admitted.summary.willRun).toBe(1);
  expect(admitted.command).toEqual([
    process.execPath,
    "run",
    "scripts/dev-guides.ts",
    "--once",
    "docs/guides/live-demo.mdx",
  ]);
  expect(admitted.notRun).toBeUndefined();
});

test("the run plan invokes dev:guides once with the caller's environment", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const env = { LANDO_GUIDE_E2E: undefined as string | undefined };
  const plan = affectedGuideRunPlan(selection, env);
  expect(plan.command).toEqual([
    process.execPath,
    "run",
    "scripts/dev-guides.ts",
    "--once",
    "docs/guides/demo.mdx",
  ]);
  expect(plan.env).toBe(env);
  expect(plan.e2eCommand).toContain("LANDO_GUIDE_E2E=1");
  expect(plan.e2eCommand).toContain("bun run dev:guides docs/guides/demo.mdx --once");
});

test("the run plan has no command when every variant is skipped", async () => {
  const root = await fixture();
  await put(
    root,
    "docs/guides/skips-only.mdx",
    guideFile("skips-only", scenario("darwin-only", ' platforms={["darwin"]}')),
  );
  await put(root, "pkg/src/skipped.ts", "export const skipped = 1;\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/skipped.ts"],
    hostPlatform: "linux",
    entries: [
      { feature: "skips-only", guide: "docs/guides/skips-only.mdx", sources: ["pkg/src/skipped.ts"] },
    ],
  });
  const plan = affectedGuideRunPlan(selection, {});
  expect(plan.command).toBeUndefined();
  expect(plan.summary.willRun).toBe(0);
  expect(plan.summary.skipped).toBe(1);
});

test("the e2e command uses the caller's binary and socket and names every e2e-bearing guide", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts", "pkg/src/live.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {
    LANDO_SCENARIO_E2E_BINARY: "/tmp/lando",
    LANDO_TEST_PODMAN_SOCKET: "/tmp/podman.sock",
  });
  expect(plan.e2eCommand).toContain("LANDO_SCENARIO_E2E_BINARY=/tmp/lando");
  expect(plan.e2eCommand).toContain("LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock");
  expect(plan.e2eCommand).toContain(
    "bun run dev:guides docs/guides/demo.mdx docs/guides/live-demo.mdx --once",
  );
  expect(plan.e2eCommand).not.toContain("<");
  expect(plan.e2eHints).toEqual([]);
});

test("the e2e command uses a built core/dist/lando and only the socket path needs replacing", async () => {
  const root = await guideRepository();
  await put(root, "core/dist/lando", "#!/bin/sh\n");
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {});
  expect(plan.e2eCommand).toContain("LANDO_SCENARIO_E2E_BINARY=core/dist/lando");
  expect(plan.e2eCommand).toContain("LANDO_TEST_PODMAN_SOCKET=/path/to/podman.sock");
  expect(plan.e2eCommand).not.toContain("<");
  expect(plan.e2eHints).toHaveLength(1);
  expect(plan.e2eHints[0]).toContain("replace /path/to/podman.sock");
});

test("the e2e command still names core/dist/lando when it is not built, plus the build hint", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {});
  expect(plan.e2eCommand).toContain("LANDO_SCENARIO_E2E_BINARY=core/dist/lando");
  expect(plan.e2eCommand).not.toContain("<");
  expect(plan.e2eHints.some((hint) => hint.includes("(cd core && bun run build)"))).toBe(true);
});

test("the not-executed reason names each cause in a mixed selection", () => {
  const base = { guides: 1, variants: 4, willRun: 0 };
  const skippedOnly = notExecutedReason({ ...base, skipped: 2, e2eNotAdmitted: 0 });
  expect(skippedOnly).toContain("2 selected guide variants are skipped by rule");
  expect(skippedOnly).not.toContain("e2e");

  const e2eOnly = notExecutedReason({ ...base, skipped: 0, e2eNotAdmitted: 3 });
  expect(e2eOnly).toContain("3 e2e variants are not admitted");
  expect(e2eOnly).not.toContain("skipped by rule");

  const both = notExecutedReason({ ...base, skipped: 1, e2eNotAdmitted: 1 });
  expect(both).toContain("1 selected guide variant is skipped by rule");
  expect(both).toContain("1 e2e variant is not admitted");
  expect(both).toContain(" and ");

  expect(notExecutedReason({ ...base, skipped: 0, e2eNotAdmitted: 0 })).toContain(
    "no unit test file and no home-guide scenario variant was selected",
  );
});

test(
  "the CLI succeeds after the unit pass but reports the e2e variants it did not run",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "LANDO_GUIDE_E2E"),
    );
    // Built at run time: a literal guide path would make the CLI's own selection
    // include this test file, whose child would then spawn the CLI again.
    const guidePath = ["docs", "guides", "recipes", "drupal-production-copy.mdx"].join("/");
    // CI unit-shard checkouts are depth 1 with no origin/main ref; HEAD keeps the
    // comparison local while still exercising the CLI's --run orchestration.
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/test-affected.ts", "--file", guidePath, "--base", "HEAD", "--run"],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(`[test-affected] not run: 1 e2e variant in ${guidePath} (not admitted)`);
    expect(stdout).toContain("LANDO_GUIDE_E2E=1");
    expect(stdout).toContain(`bun run dev:guides ${guidePath} --once`);
    expect(`${stdout}${stderr}`).not.toContain("guide run expected");
  },
  { timeout: 180000 },
);

test("a deleted path that matches two features' globs selects both guides", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/other.mdx", guideFile("other", scenario("runs")));
  await put(root, "pkg/src/kept.ts", "export const kept = 1;\n");
  await put(root, "pkg/legacy/x.ts", "export const legacy = 1;\n");

  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/x.ts"],
    hostPlatform: "linux",
    entries: [
      { feature: "nested-sources", guide: "docs/guides/demo.mdx", sources: ["pkg/**/x.ts"] },
      { feature: "flat-sources", guide: "docs/guides/other.mdx", sources: ["pkg/src/*.ts"] },
    ],
  });
  expect(selection.diagnostics).toEqual([]);
  expect(selection.guides.map((guide) => guide.guideId).sort()).toEqual(["demo", "other"]);
});

test("reasons accumulate when a path is both a covered source and a guide", async () => {
  const root = await fixture();
  await put(root, "docs/guides/other.mdx", guideFile("other", scenario("runs")));
  await put(root, "recipes/demo/README.mdx", guideFile("recipe-demo", scenario("runs")));

  const selection = await selectAffectedGuides({
    root,
    changed: ["recipes/demo/README.mdx"],
    hostPlatform: "linux",
    entries: [
      { feature: "recipe-demo", guide: "docs/guides/other.mdx", sources: ["recipes/demo/README.mdx"] },
    ],
  });
  expect(selection.diagnostics).toEqual([]);
  const reasons = selection.guides.flatMap((guide) => guide.reasons);
  expect(reasons).toContain("recipes/demo/README.mdx -> feature recipe-demo");
  expect(reasons).toContain("recipes/demo/README.mdx guide changed");
  expect(selection.selectedPaths).toContain("recipes/demo/README.mdx");
});

test("shell-quotes e2e values and guide paths only when they need it", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/with space.mdx", guideFile("spaced", scenario("live", ' layer="e2e"')));

  const selection = await selectAffectedGuides({
    root,
    changed: ["docs/guides/with space.mdx"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {
    LANDO_SCENARIO_E2E_BINARY: "/tmp/lando binary",
    LANDO_TEST_PODMAN_SOCKET: "/tmp/podman socket.sock",
  });

  expect(plan.e2eCommand).toContain("LANDO_SCENARIO_E2E_BINARY='/tmp/lando binary'");
  expect(plan.e2eCommand).toContain("LANDO_TEST_PODMAN_SOCKET='/tmp/podman socket.sock'");
  expect(plan.e2eCommand).toContain("'docs/guides/with space.mdx' --once");
  expect(plan.e2eCommand).not.toContain("<");
});

test("prints a single-quotable command for a path containing a quote", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/it's here.mdx", guideFile("quoted", scenario("live", ' layer="e2e"')));

  const selection = await selectAffectedGuides({
    root,
    changed: ["docs/guides/it's here.mdx"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {});
  expect(plan.e2eCommand).toContain(`'docs/guides/it'\\''s here.mdx'`);
});

test("the closing report also names variants skipped by rule", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {});
  expect(plan.notRun).toStartWith("not run: ");
  expect(plan.notRun).toContain("1 e2e variant in docs/guides/demo.mdx (not admitted)");
  expect(plan.notRun).toContain("2 skipped variants in docs/guides/demo.mdx (skipped by rule)");
});

test("a map with a missing guide reports diagnostics instead of crashing selection", async () => {
  const root = await fixture();
  await put(root, "pkg/src/covered.ts", "export const covered = 1;\n");

  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: [{ feature: "gone", guide: "docs/guides/gone.mdx", sources: ["pkg/src/covered.ts"] }],
  });

  expect(selection.guides).toEqual([]);
  expect(selection.diagnostics.map((diagnostic) => diagnostic.code)).toContain("registry.unknown-guide");
});

test("a map with an unparseable guide reports diagnostics instead of crashing selection", async () => {
  const root = await fixture();
  await put(root, "docs/guides/broken.mdx", "---\nid: [not, a, string]\n---\n");
  await put(root, "pkg/src/covered.ts", "export const covered = 1;\n");

  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/covered.ts"],
    hostPlatform: "linux",
    entries: [{ feature: "broken", guide: "docs/guides/broken.mdx", sources: ["pkg/src/covered.ts"] }],
  });

  expect(selection.guides).toEqual([]);
  expect(selection.diagnostics.map((diagnostic) => diagnostic.code)).toContain("registry.guide-invalid");
});

test("a fixture edit still selects its guide when an unrelated guide has invalid frontmatter", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/known.mdx", guideFile("known", scenario("runs")));
  await put(root, "docs/guides/broken.mdx", "---\nid: [not, a, string]\n---\n");
  await put(root, "docs/guides/known/fixtures/app/.lando.yml", "name: known\n");

  const selection = await selectAffectedGuides({
    root,
    changed: ["docs/guides/known/fixtures/app/.lando.yml"],
    hostPlatform: "linux",
    entries: [{ feature: "known", guide: "docs/guides/known.mdx", sources: ["pkg/src/covered.ts"] }],
  });

  expect(selection.diagnostics).toEqual([]);
  expect(selection.guides.map((guide) => guide.guideId)).toEqual(["known"]);
});

test("a selected guide that fails to parse is a diagnostic naming its path", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/broken.mdx", "---\nid: [not, a, string]\n---\n");

  const selection = await selectAffectedGuides({
    root,
    changed: ["docs/guides/broken.mdx"],
    hostPlatform: "linux",
    entries: demoEntries,
  });

  expect(selection.guides).toEqual([]);
  expect(selection.diagnostics).toHaveLength(1);
  expect(selection.diagnostics[0]?.code).toBe("selection.guide-invalid");
  expect(selection.diagnostics[0]?.message).toContain('"docs/guides/broken.mdx"');
});

test("the unit child drops live-test opt-ins while the guide child keeps them", async () => {
  const root = await guideRepository();
  const caller: Record<string, string | undefined> = {
    LANDO_GUIDE_E2E: "1",
    LANDO_SCENARIO_E2E_BINARY: "/tmp/lando",
    LANDO_TEST_PODMAN_SOCKET: "/tmp/podman.sock",
    LANDO_TEST_DOCKER_SOCKET: "/var/run/docker.sock",
    LANDO_TEST_WINDOWS_DOCKER_SOCKET: "//./pipe/docker_engine",
    LANDO_TEST_USE_REAL_ROOTS: "1",
    PATH: "/bin",
    HOME: "/home/test",
  };
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/live.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, caller);

  expect(unitTestEnvironment(caller)).toEqual({ PATH: "/bin", HOME: "/home/test" });
  expect(plan.command).toBeDefined();
  expect(plan.env).toBe(caller);
  expect(plan.env.LANDO_GUIDE_E2E).toBe("1");
  expect(plan.env.LANDO_SCENARIO_E2E_BINARY).toBe("/tmp/lando");
  expect(plan.env.LANDO_TEST_PODMAN_SOCKET).toBe("/tmp/podman.sock");
});

test("renders a PowerShell e2e command on win32", async () => {
  const root = await guideRepository();
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/live.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  const plan = affectedGuideRunPlan(selection, {}, "win32");

  expect(plan.command).toBeUndefined();
  expect(plan.e2eCommand).toBe(
    "$env:LANDO_GUIDE_E2E='1'; $env:LANDO_SCENARIO_E2E_BINARY='core\\dist\\lando.exe'; $env:LANDO_TEST_PODMAN_SOCKET='\\\\.\\pipe\\podman-lando'; bun run dev:guides 'docs/guides/live-demo.mdx' --once",
  );
  expect(plan.e2eHints).toEqual([
    expect.stringContaining(
      "core\\dist\\lando.exe does not exist yet; build it with bun --cwd=core run build.",
    ),
    expect.stringContaining("replace \\\\.\\pipe\\podman-lando with the answering Podman named pipe"),
    expect.stringContaining("PowerShell $env: assignments last for the rest of this session"),
  ]);
  expect(plan.e2eRunNote).toContain("$env:");
});

test("quotes spaces and apostrophes in both e2e renderings", async () => {
  const root = await guideRepository();
  await put(root, "docs/guides/it's here.mdx", guideFile("quoted", scenario("live", ' layer="e2e"')));
  const selection = await selectAffectedGuides({
    root,
    changed: ["pkg/src/live.ts"],
    hostPlatform: "linux",
    entries: demoEntries,
  });

  const posix = affectedGuideRunPlan(selection, {
    LANDO_SCENARIO_E2E_BINARY: "/tmp/lando's binary",
    LANDO_TEST_PODMAN_SOCKET: "/tmp/podman socket.sock",
  });
  expect(posix.e2eCommand).toContain("LANDO_SCENARIO_E2E_BINARY='/tmp/lando'\\''s binary'");
  expect(posix.e2eCommand).toContain("LANDO_TEST_PODMAN_SOCKET='/tmp/podman socket.sock'");

  const windows = affectedGuideRunPlan(
    selection,
    {
      LANDO_SCENARIO_E2E_BINARY: "C:\\Program Files\\lando's.exe",
      LANDO_TEST_PODMAN_SOCKET: "\\\\.\\pipe\\lando bridge.sock",
    },
    "win32",
  );
  expect(windows.e2eCommand).toContain("$env:LANDO_SCENARIO_E2E_BINARY='C:\\Program Files\\lando''s.exe'");
  expect(windows.e2eCommand).toContain("$env:LANDO_TEST_PODMAN_SOCKET='\\\\.\\pipe\\lando bridge.sock'");

  const quotedSelection = await selectAffectedGuides({
    root,
    changed: ["docs/guides/it's here.mdx"],
    hostPlatform: "linux",
    entries: demoEntries,
  });
  expect(affectedGuideRunPlan(quotedSelection, {}, "win32").e2eCommand).toContain(
    "'docs/guides/it''s here.mdx'",
  );
});
