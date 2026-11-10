import { expect, test } from "bun:test";
import { join } from "node:path";
import { TestSelectionError, runTestSelection } from "../../../scripts/run-test-selection.ts";
import { collectTestFiles, resolveTestSelection } from "../../../scripts/test-selection-files.ts";
import { type TestSelection, selectionMatches } from "../../../scripts/test-selections.ts";
import { createTestSelectionFixture } from "./support/test-selection-fixture.ts";

const runCapturedSelection = async (root: string, selection: TestSelection) => {
  const runner = new URL("../../../scripts/run-test-selection.ts", import.meta.url).href;
  await using child = Bun.spawn(
    [
      process.execPath,
      "--no-orphans",
      "--eval",
      `import { runTestSelection } from ${JSON.stringify(runner)};
       process.exitCode = await runTestSelection(${JSON.stringify(selection.id)}, ${JSON.stringify({ root, selections: [selection] })});`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
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

test("matches file, tree, and glob selectors without substring expansion", () => {
  expect(selectionMatches({ id: "tree", paths: ["pkg/test/"], jobs: [] }, "pkg/test/nested/a.test.ts")).toBe(
    true,
  );
  expect(selectionMatches({ id: "tree", paths: ["pkg/test/"], jobs: [] }, "other/pkg/test/a.test.ts")).toBe(
    false,
  );
  expect(
    selectionMatches({ id: "glob", paths: ["pkg/test/*.test.ts"], jobs: [] }, "pkg/test/nested/a.test.ts"),
  ).toBe(false);
});
