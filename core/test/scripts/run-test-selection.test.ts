import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestSelectionError, runTestSelection } from "../../../scripts/run-test-selection.ts";
import { collectTestFiles, resolveTestSelection } from "../../../scripts/test-selection-files.ts";
import {
  type ContributorTestPreset,
  type TestSelection,
  selectionMatches,
} from "../../../scripts/test-selections.ts";
import { createTestSelectionFixture } from "./support/test-selection-fixture.ts";

const ROOT_KEYS = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

const runCapturedSelection = async (
  root: string,
  selection: TestSelection | ContributorTestPreset,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const runner = new URL("../../../scripts/run-test-selection.ts", import.meta.url).href;
  await using child = Bun.spawn(
    [
      process.execPath,
      "--no-orphans",
      "--eval",
      `import { runTestSelection } from ${JSON.stringify(runner)};
       process.exitCode = await runTestSelection(${JSON.stringify(selection.id)}, ${JSON.stringify({
         root,
         ...("kind" in selection ? { presets: [selection] } : { selections: [selection] }),
       })});`,
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: Bun.stripANSI(`${stdout}\n${stderr}`) };
};

test("resolves exact paths and propagates a failing Bun result without running suffix matches", async () => {
  await using fixture = await createTestSelectionFixture();
  const receipt = join(fixture.root, "receipt.txt");
  const source = (label: string, fail: boolean) => `import { test, expect } from "bun:test";
    import { appendFileSync } from "node:fs";
    test(${JSON.stringify(label)}, () => {
      appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(`${label}\n`)});
      expect(${fail}).toBe(false);
    });`;
  await fixture.put("pkg/test/selected.test.ts", source("selected", true));
  await fixture.put("docs/test/pkg/test/selected.test.ts", source("excluded-suffix", false));
  await fixture.put("pkg/test/ignored.test.ts", source("excluded-ignore", false));
  const selection: TestSelection = {
    id: "exact",
    paths: ["pkg/test/selected.test.ts", "pkg/test/*.test.ts"],
    ignore: ["**/unit.test.ts", "**/ignored.test.ts", "**/*.integration.test.ts"],
    jobs: [],
  };
  expect(resolveTestSelection(selection, await collectTestFiles(fixture.root))).toEqual([
    "pkg/test/selected.test.ts",
  ]);
  const { code, output } = await runCapturedSelection(fixture.root, selection);
  expect(code, output).toBe(1);
  expect(output).toContain("(fail) selected");
  expect(output).toMatch(/^\s*0 pass\s*$/mu);
  expect(output).toMatch(/^\s*1 fail\s*$/mu);
  expect(await Bun.file(receipt).text()).toBe("selected\n");
});

test("runs a tree selector through Bun's directory walk with ignore patterns and no suffix matches", async () => {
  await using fixture = await createTestSelectionFixture();
  const receipt = join(fixture.root, "receipt.txt");
  const source = (label: string) => `import { test } from "bun:test";
    import { appendFileSync } from "node:fs";
    test(${JSON.stringify(label)}, () => appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(`${label}\n`)}));`;
  await fixture.put("pkg/test/tree.test.ts", source("tree"));
  await fixture.put("pkg/test/live.integration.test.ts", source("ignored"));
  await fixture.put("other/pkg/test/tree.test.ts", source("suffix"));
  const selection: TestSelection = {
    id: "tree",
    paths: ["pkg/test/"],
    ignore: ["**/*.integration.test.ts"],
    jobs: [],
  };
  const { code, output } = await runCapturedSelection(fixture.root, selection);
  expect(code, output).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("tree\n");
});

test("runs a contributor preset by id without running its ignored files", async () => {
  await using fixture = await createTestSelectionFixture();
  const receipt = join(fixture.root, "preset.txt");
  await fixture.put(
    "pkg/test/unit.test.ts",
    `import { test } from "bun:test";
    test("selected case", async () => { await Bun.write(${JSON.stringify(receipt)}, "selected"); });`,
  );
  await fixture.put(
    "pkg/test/live.integration.test.ts",
    `import { test } from "bun:test";
    test("ignored case", () => { throw new Error("Preset ran a live test"); });`,
  );
  const { code, output } = await runCapturedSelection(fixture.root, {
    kind: "preset",
    id: "upgrade",
    paths: ["pkg/test/"],
    ignore: ["**/*.integration.test.ts"],
  });
  expect(code, output).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("selected");
});

test("rejects unknown, empty, and Go selections before spawning Bun", async () => {
  await using fixture = await createTestSelectionFixture();
  const selections = [
    ...fixture.selections,
    { id: "empty", paths: ["missing.test.ts"], jobs: [] },
    { id: "go", paths: ["core/container-helper/**/*_test.go"], runner: "go", jobs: [] },
  ] satisfies readonly TestSelection[];
  for (const expected of [
    {
      id: "bogus",
      reason: "unknown",
      message: 'Unknown test selection "bogus"; see scripts/test-selections.ts.',
    },
    {
      id: "empty",
      reason: "empty",
      message: 'Test selection "empty" resolved to zero files; check scripts/test-selections.ts.',
    },
    {
      id: "go",
      reason: "runner",
      message: 'Test selection "go" uses the Go container builder, not the Bun runner.',
    },
  ]) {
    const result = runTestSelection(expected.id, { root: fixture.root, selections });
    await expect(result).rejects.toBeInstanceOf(TestSelectionError);
    await expect(result).rejects.toMatchObject(expected);
  }
});

test("executes filtered selections while forwarding their name filter to Bun", async () => {
  await using fixture = await createTestSelectionFixture();
  const receipt = join(fixture.root, "filtered.txt");
  await fixture.put(
    "pkg/test/filtered.test.ts",
    `import { test } from "bun:test";
    test("kept case", async () => { await Bun.write(${JSON.stringify(receipt)}, "kept"); });
    test("omitted case", () => { throw new Error("Name filter was not forwarded"); });`,
  );
  const selection: TestSelection = {
    id: "filtered",
    paths: ["pkg/test/filtered.test.ts"],
    args: ["--test-name-pattern", "kept case"],
    jobs: [],
  };
  const { code, output } = await runCapturedSelection(fixture.root, selection);
  expect(code, output).toBe(0);
  expect(output).toMatch(/^\s*1 pass\s*$/mu);
  expect(output).toMatch(/^\s*1 filtered out\s*$/mu);
  expect(await Bun.file(receipt).text()).toBe("kept");
});

test.each([
  { kind: "an ordinary selection", live: false },
  { kind: "a live selection", live: true },
])("fills unset roots with a runner-owned tree only for $kind", async ({ live }) => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put(
    "pkg/test/roots.test.ts",
    `import { test } from "bun:test";
    test("roots", () => { console.log("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? "")); });`,
  );
  const selection: TestSelection = {
    id: "roots",
    paths: ["pkg/test/roots.test.ts"],
    jobs: [],
    ...(live ? { usesInheritedLivePodmanRoots: true } : {}),
  };
  const env = { ...process.env };
  for (const key of [...ROOT_KEYS, "LANDO_TEST_USE_REAL_ROOTS", "LANDO_TEST_PODMAN_SOCKET"]) delete env[key];
  const { code, output } = await runCapturedSelection(fixture.root, selection, env);
  expect(code, output).toBe(0);
  const root = /ROOT=(.*)/.exec(output)?.[1]?.trim() ?? "";
  // A live selection leaves every key unset so runWithLiveTestRoots can allocate Podman roots.
  expect({
    owned: root.startsWith(join(tmpdir(), "lando-test-roots-")),
    left: root !== "" && existsSync(dirname(root)),
  }).toEqual({ owned: !live, left: false });
});

test("matches file, tree, and glob selectors without substring expansion", () => {
  expect(selectionMatches({ id: "tree", paths: ["pkg/test/"] }, "pkg/test/nested/a.test.ts")).toBe(true);
  expect(selectionMatches({ id: "tree", paths: ["pkg/test/"] }, "other/pkg/test/a.test.ts")).toBe(false);
  expect(selectionMatches({ id: "glob", paths: ["pkg/test/*.test.ts"] }, "pkg/test/nested/a.test.ts")).toBe(
    false,
  );
});
