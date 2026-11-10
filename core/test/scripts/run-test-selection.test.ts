import { expect, test } from "bun:test";
import { join } from "node:path";
import { TestSelectionError, runTestSelection } from "../../../scripts/run-test-selection.ts";
import { collectTestFiles, resolveTestSelection } from "../../../scripts/test-selection-files.ts";
import { type TestSelection, selectionMatches } from "../../../scripts/test-selections.ts";
import { createTestSelectionFixture } from "./support/test-selection-fixture.ts";

test("resolves sorted exact paths and propagates a failing Bun result without running suffix matches", async () => {
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
  expect(await runTestSelection("exact", { root: fixture.root, selections: [selection] })).toBe(1);
  expect(await Bun.file(receipt).text()).toBe("selected\n");
});

test("rejects unknown, empty, and Go selections before spawning Bun", async () => {
  await using fixture = await createTestSelectionFixture();
  const options = { root: fixture.root, selections: fixture.selections };
  await expect(runTestSelection("bogus", options)).rejects.toMatchObject({ reason: "unknown", id: "bogus" });
  for (const selection of [
    { id: "empty", paths: ["missing.test.ts"], jobs: [] },
    { id: "go", paths: ["core/container-helper/**/*_test.go"], runner: "go", jobs: [] },
  ] satisfies readonly TestSelection[]) {
    await expect(
      runTestSelection(selection.id, { ...options, selections: [selection] }),
    ).rejects.toBeInstanceOf(TestSelectionError);
  }
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
