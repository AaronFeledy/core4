import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type TestOwnershipCode,
  type TestOwnershipIssue,
  checkTestOwnership,
  collectTestInventory,
  formatOwnershipIssue,
} from "../../../scripts/test-ownership.ts";
import { collectShardedTestFiles } from "../../../scripts/test-shards.ts";
import { createTestSelectionFixture } from "./support/test-selection-fixture.ts";

const sample = (issues: readonly TestOwnershipIssue[], code: TestOwnershipCode) => {
  const issue = issues.find((entry) => entry.code === code);
  if (issue === undefined) throw new Error(`Missing ${code}: ${JSON.stringify(issues)}`);
  console.log(formatOwnershipIssue(issue));
  return issue;
};

test("derives multiple owners and prerequisites from declarations without reading workflows during unit collection", async () => {
  await using fixture = await createTestSelectionFixture();
  expect((await checkTestOwnership(fixture.options)).issues).toEqual([]);
  await rm(join(fixture.root, ".github"), { recursive: true });
  expect(await collectTestInventory(fixture.options)).toEqual([
    { path: "pkg/test/live.integration.test.ts", owners: ["live"], needs: "Fixture socket" },
    { path: "pkg/test/unit.test.ts", owners: ["unit"] },
  ]);
  expect(await collectShardedTestFiles(fixture.root)).toEqual(["pkg/test/unit.test.ts"]);
});

test.each([
  "",
  "bun run test:selection live-extra",
  "echo bun run test:selection live",
  "# bun run test:selection live",
])("rejects absent execution or a non-invoking runner reference: %s", async (run) => {
  await using fixture = await createTestSelectionFixture();
  await fixture.workflow(run);
  const { issues } = await checkTestOwnership(fixture.options);
  expect(issues.map((issue) => issue.code)).toEqual(["UNBOUND_SELECTION"]);
  expect(sample(issues, "UNBOUND_SELECTION").paths).toEqual(["live", "ci.yml", "live"]);
});

test("checks each positive selector separately even when a sibling selector still matches", async () => {
  await using fixture = await createTestSelectionFixture();
  const selection = fixture.selections[0];
  if (selection === undefined) throw new Error("Missing fixture selection");
  const { issues } = await checkTestOwnership({
    ...fixture.options,
    selections: [{ ...selection, paths: [...selection.paths, "pkg/test/missing*.test.ts"] }],
  });
  expect(issues.map((issue) => issue.code)).toEqual(["STALE_SELECTOR"]);
  expect(sample(issues, "STALE_SELECTOR").paths).toEqual(["live", "pkg/test/missing*.test.ts"]);
});

test("does not let a selection with no job bindings hide a test from units", async () => {
  await using fixture = await createTestSelectionFixture();
  const { entries, issues } = await checkTestOwnership({
    ...fixture.options,
    selections: [
      ...fixture.selections,
      { id: "dedicated", paths: ["pkg/test/unit.test.ts"], unit: "exclude", jobs: [] },
    ],
  });
  expect(entries.find((entry) => entry.path === "pkg/test/unit.test.ts")?.owners).toEqual(["dedicated"]);
  expect(issues.map((issue) => [issue.code, issue.paths])).toEqual([["UNBOUND_SELECTION", ["dedicated"]]]);
});

test("reports an unowned integration with actionable filename, selection, and manual remedies", async () => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put("pkg/test/unowned.integration.test.ts");
  const { issues } = await checkTestOwnership(fixture.options);
  expect(issues.map((issue) => issue.code)).toEqual(["UNOWNED"]);
  const issue = sample(issues, "UNOWNED");
  expect(issue.paths).toEqual(["pkg/test/unowned.integration.test.ts"]);
  expect(issue.remediation).toContain("scripts/test-selections.ts");
  expect(issue.remediation).toContain("*.test.ts");
  expect(issue.remediation).toContain("MANUAL_TESTS");
});

test.each([
  "bun test pkg/test/unit.test.ts",
  "bun --no-orphans test pkg/test/unit.test.ts",
  "env FIXTURE=1 bun test pkg/test/unit.test.ts",
])("rejects raw test execution: %s", async (command) => {
  await using fixture = await createTestSelectionFixture();
  await fixture.workflow(`bun run test:selection live\n${command}`);
  const { issues } = await checkTestOwnership(fixture.options);
  expect(issues.map((issue) => issue.code)).toEqual(["RAW_BUN_TEST"]);
  expect(sample(issues, "RAW_BUN_TEST").paths).toEqual(["ci.yml", "live"]);
});

test("pattern-only and advisory matrix checks cannot own a whole file", async () => {
  await using fixture = await createTestSelectionFixture();
  const path = "pkg/test/matrix.integration.test.ts";
  await fixture.put(path);
  const planChecks = [
    { id: "matrix:pattern", command: ["bun", "test", path, "--test-name-pattern", "live case"] },
    { id: "matrix:advisory", command: ["bun", "test", path], advisory: true },
  ];
  expect(
    (await checkTestOwnership({ ...fixture.options, planChecks })).issues.map((issue) => issue.code),
  ).toEqual(["UNOWNED"]);
  const result = await checkTestOwnership({
    ...fixture.options,
    planChecks: [...planChecks, { id: "matrix:whole-file", command: ["bun", "test", path] }],
  });
  expect(result.issues).toEqual([]);
  expect(result.entries.find((entry) => entry.path === path)?.owners).toEqual(["matrix:whole-file"]);
});

test("unit exclusions follow matched selections after ignores without excluding adjacent files", async () => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put("pkg/test/dedicated/owned.test.ts");
  await fixture.put("pkg/test/dedicated/ordinary.test.ts");
  const entries = await collectTestInventory({
    ...fixture.options,
    selections: [
      ...fixture.selections,
      {
        id: "dedicated",
        paths: ["pkg/test/dedicated/"],
        ignore: ["**/ordinary.test.ts"],
        unit: "exclude",
        jobs: [],
      },
    ],
  });
  expect(entries.filter((entry) => entry.owners.includes("unit")).map((entry) => entry.path)).toEqual([
    "pkg/test/dedicated/ordinary.test.ts",
    "pkg/test/unit.test.ts",
  ]);
  expect(entries.find((entry) => entry.path.endsWith("/owned.test.ts"))?.owners).toEqual(["dedicated"]);
});

test("ignores gitignored files and omits tracked worktree deletions", async () => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put(".gitignore", "pkg/test/ignored.test.ts\n");
  await fixture.put("pkg/test/ignored.test.ts");
  await fixture.put("pkg/test/deleted.test.ts");
  const child = Bun.spawn(["git", "add", "pkg/test/deleted.test.ts"], {
    cwd: fixture.root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  await rm(join(fixture.root, "pkg/test/deleted.test.ts"));
  expect((await collectTestInventory(fixture.options)).map((entry) => entry.path)).toEqual([
    "pkg/test/live.integration.test.ts",
    "pkg/test/unit.test.ts",
  ]);
});

test("reports unknown test locations and stale or selected manual gaps together", async () => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put("forgotten/test/lost.test.ts");
  const { issues } = await checkTestOwnership({
    ...fixture.options,
    manual: {
      "pkg/test/live.integration.test.ts": "Fixture socket",
      "pkg/test/missing.integration.test.ts": "Missing fixture socket",
    },
  });
  expect(issues.map((issue) => issue.code)).toEqual(["MANUAL_SELECTED", "MANUAL_STALE", "UNKNOWN_LOCATION"]);
  expect(sample(issues, "MANUAL_SELECTED").paths).toEqual(["pkg/test/live.integration.test.ts"]);
  expect(sample(issues, "MANUAL_STALE").paths).toEqual(["pkg/test/missing.integration.test.ts"]);
  expect(sample(issues, "UNKNOWN_LOCATION").paths).toEqual(["forgotten/test/lost.test.ts"]);
  expect(await collectShardedTestFiles(fixture.root)).toEqual(["pkg/test/unit.test.ts"]);
});

test("checks the exact unit shard matrix and the Go builder without treating Go files as Bun units", async () => {
  await using fixture = await createTestSelectionFixture();
  await fixture.put("core/container-helper/main_test.go", "package main\n");
  await fixture.workflow(
    "bun run test:selection live\nbun run scripts/build-container-helper.ts --test",
    [1, 2],
  );
  const { entries, issues } = await checkTestOwnership({
    ...fixture.options,
    selections: [
      ...fixture.selections,
      {
        id: "container-helper-go",
        paths: ["core/container-helper/**/*_test.go"],
        runner: "go",
        jobs: [{ workflow: "ci.yml", job: "live" }],
      },
    ],
  });
  expect(entries.find((entry) => entry.path.endsWith(".go"))?.owners).toEqual(["container-helper-go"]);
  expect(issues.map((issue) => issue.paths)).toEqual([["unit", "ci.yml", "unit-tests-linux-x64-shard"]]);
});

test("the real repository has no unowned tests or unexecuted declarations", async () => {
  const result = await checkTestOwnership();
  expect(result.issues.map(formatOwnershipIssue)).toEqual([]);
});
