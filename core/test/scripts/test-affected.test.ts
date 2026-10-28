import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { affectedTestCommand, changedPaths, selectAffectedTests } from "../../../scripts/test-affected.ts";
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
  await put(root, "pkg/src/zbarrel.ts", "export {};\n");
  await rm(join(root, "pkg/src/old.ts"));
  const changed = await changedPaths(root, "HEAD");
  expect(changed).toEqual(["pkg/src/old.ts", "pkg/src/zbarrel.ts"]);
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

test("reports both rename paths and untracked names containing spaces", async () => {
  const root = await fixture();
  await put(root, "pkg/src/old name.ts", "export {};\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  await rename(join(root, "pkg/src/old name.ts"), join(root, "pkg/src/new name.ts"));
  await put(root, "pkg/src/extra name.ts", "export {};\n");
  expect(await changedPaths(root, "HEAD")).toEqual([
    "pkg/src/extra name.ts",
    "pkg/src/new name.ts",
    "pkg/src/old name.ts",
  ]);
});

test("finds the historical schema regressions in the current repository", async () => {
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
});

test("finds the historical fixture and digest regressions", async () => {
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
});

test("selects every canonical eligible test for the repository preload roots", async () => {
  const eligible = await collectShardedTestFiles();
  const result = await selectAffectedTests({
    root: resolve(import.meta.dirname, "../../.."),
    changed: ["scripts/test-preload-roots.ts"],
    eligible,
  });
  expect(result.selected).toEqual(eligible);
  expect(result.sharedPreloadTests).toEqual(eligible);
  expect(result.unmatched).toEqual([]);
});
