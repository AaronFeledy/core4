import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuideDriftGate } from "../../../scripts/check-guide-drift.ts";
import { GitChangeError } from "../../../scripts/git-changes.ts";
import {
  CONTAINER_COMMAND_BASELINE_PATH,
  addedContainerCommandEntries,
  checkContainerCommandBaselineOnDisk,
} from "../../../scripts/guides/container-command-baseline.ts";
import type { HomeGuideEntry } from "../../../scripts/guides/home-guide-registry.ts";

const homePage = "docs/guides/home.mdx";
const command = "lando exec app -- php -m";
const added = "lando logs -s app";
const base = { [homePage]: [command] };

const homeGuide = `---
id: home
provider: test
---

# Home

<Guide>
  <Scenario id="runs">
    <Step name="run">
      <Run command="version" />
    </Step>
  </Scenario>
</Guide>
`;

const homeEntries: readonly HomeGuideEntry[] = [
  { feature: "home", guide: homePage, sources: ["src/covered.ts"] },
];

test.each([
  {
    name: "rejects an added command",
    current: { [homePage]: [command, added] },
    expected: [{ path: homePage, command: added }],
  },
  { name: "accepts a removed command", current: {}, expected: [] },
  { name: "accepts unchanged entries", current: base, expected: [] },
  {
    name: "carries a command from a removed guide",
    current: { "docs/guides/renamed.mdx": [command] },
    removed: [homePage],
    expected: [],
  },
  {
    name: "rejects a new command on a moved guide",
    current: { "docs/guides/renamed.mdx": [command, added] },
    removed: [homePage],
    expected: [{ path: "docs/guides/renamed.mdx", command: added }],
  },
  {
    name: "rejects a copy while the original guide still exists",
    current: { "docs/guides/renamed.mdx": [command] },
    expected: [{ path: "docs/guides/renamed.mdx", command }],
  },
  {
    name: "does not let one moved entry become two",
    current: { "docs/guides/renamed.mdx": [command], "recipes/demo/README.mdx": [command] },
    removed: [homePage],
    expected: [{ path: "recipes/demo/README.mdx", command }],
  },
  {
    name: "does not carry an entry that remains at the old path",
    current: { ...base, "docs/guides/renamed.mdx": [command] },
    removed: [homePage],
    expected: [{ path: "docs/guides/renamed.mdx", command }],
  },
])("$name", ({ current, removed, expected }) => {
  expect(addedContainerCommandEntries(base, current, new Set(removed))).toEqual(expected);
});

const git = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_MASTER: "1" },
  });
  if (!result.success) throw new Error(result.stderr.toString());
};

const commitBase = (root: string): void => {
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Set up base",
  ]);
};

test.each([
  {
    name: "compares a base without a baseline as an empty baseline",
    onBase: "neither",
    expected: [
      [homePage, command],
      ["docs/guides/added.mdx", added],
    ],
  },
  {
    name: "treats a missing baseline as empty if the base already has the rule",
    onBase: "rule",
    expected: [
      [homePage, command],
      ["docs/guides/added.mdx", added],
    ],
  },
  {
    name: "rejects working-tree growth when a baseline exists",
    onBase: "baseline",
    expected: [["docs/guides/added.mdx", added]],
  },
] as const)("$name", async ({ onBase, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-baseline-"));
  try {
    await mkdir(join(root, "scripts/guides"), { recursive: true });
    await mkdir(join(root, "docs/guides"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await Bun.write(join(root, homePage), homeGuide);
    await Bun.write(join(root, "src/covered.ts"), "export {};\n");
    const baselineFile = join(root, CONTAINER_COMMAND_BASELINE_PATH);
    if (onBase === "baseline") await Bun.write(baselineFile, JSON.stringify(base));
    if (onBase === "rule")
      await Bun.write(join(root, "scripts/guides/container-command-lint.ts"), "export {};\n");
    commitBase(root);
    await Bun.write(baselineFile, JSON.stringify({ ...base, "docs/guides/added.mdx": [added] }));

    const result = await runGuideDriftGate({
      root,
      env: {
        GUIDE_DRIFT_BASE_REF: "HEAD",
        GUIDE_DRIFT_PR_BODY: "Guide-Coverage-Skip: No guide changes are needed for this internal refactor.",
      },
      args: [],
      entries: homeEntries,
    });

    expect(result.stdout).not.toContain("bootstrap");
    for (const [path, argv] of expected) {
      expect(result.stderr).toContain(
        `${CONTAINER_COMMAND_BASELINE_PATH}: guide.container-command.e2e-coverage: ${path}: \`${argv}\``,
      );
    }
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not waive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compares the baseline with the base ref itself, not the merge base", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-baseline-ahead-"));
  try {
    const baselineFile = join(root, CONTAINER_COMMAND_BASELINE_PATH);
    await mkdir(join(root, "scripts/guides"), { recursive: true });
    await mkdir(join(root, "docs/guides"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await Bun.write(join(root, homePage), homeGuide);
    await Bun.write(join(root, "src/covered.ts"), "export {};\n");
    await Bun.write(baselineFile, JSON.stringify(base));
    commitBase(root);

    git(root, ["checkout", "-q", "-b", "ahead"]);
    await Bun.write(baselineFile, JSON.stringify({ ...base, "docs/guides/added.mdx": [added] }));
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "allow the new command",
    ]);
    git(root, ["checkout", "-q", "-"]);
    await Bun.write(baselineFile, JSON.stringify({ ...base, "docs/guides/added.mdx": [added] }));

    const againstBase = await runGuideDriftGate({
      root,
      env: { GUIDE_DRIFT_BASE_REF: "ahead" },
      args: [],
      entries: homeEntries,
    });
    expect(againstBase.stderr).not.toContain(CONTAINER_COMMAND_BASELINE_PATH);
    expect(againstBase.exitCode).toBe(0);

    // The merge base (the branch point) never had the allowance, so it still reports growth.
    const againstMergeBase = await runGuideDriftGate({
      root,
      env: { GUIDE_DRIFT_BASE_REF: "HEAD" },
      args: [],
      entries: homeEntries,
    });
    expect(againstMergeBase.stderr).toContain(`docs/guides/added.mdx: \`${added}\``);
    expect(againstMergeBase.exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const gitOutput = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_MASTER: "1" },
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

test("an unknown base rejects the baseline read with a GitChangeError", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-baseline-error-"));
  try {
    await mkdir(join(root, "scripts/guides"), { recursive: true });
    await Bun.write(join(root, "scripts/guides/container-command-lint.ts"), "export {};\n");
    commitBase(root);

    try {
      await checkContainerCommandBaselineOnDisk(root, "origin/does-not-exist");
    } catch (error) {
      expect(error).toBeInstanceOf(GitChangeError);
      expect((error as GitChangeError)._tag).toBe("GitChangeError");
      expect((error as GitChangeError).remediation.length).toBeGreaterThan(0);
      return;
    }
    throw new Error("expected the baseline read to reject");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed baseline git read fails the gate with a remediation and a failed summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-baseline-gitfail-"));
  try {
    await mkdir(join(root, "scripts/guides"), { recursive: true });
    await mkdir(join(root, "docs/guides"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await Bun.write(join(root, homePage), homeGuide);
    await Bun.write(join(root, "src/covered.ts"), "export {};\n");
    await Bun.write(join(root, CONTAINER_COMMAND_BASELINE_PATH), JSON.stringify(base));
    await Bun.write(join(root, "scripts/guides/container-command-lint.ts"), "export {};\n");
    commitBase(root);

    // Corrupt only the baseline blob at the base: discovery compares trees, so the
    // baseline read is the first command that needs the content.
    const blob = gitOutput(root, ["rev-parse", `HEAD:${CONTAINER_COMMAND_BASELINE_PATH}`]);
    await rm(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));

    const summaryPath = join(root, "step-summary.md");
    await Bun.write(summaryPath, "");
    const result = await runGuideDriftGate({
      root,
      env: { GUIDE_DRIFT_BASE_REF: "HEAD", GITHUB_STEP_SUMMARY: summaryPath },
      args: [],
      entries: homeEntries,
    });
    const summary = await Bun.file(summaryPath).text();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("GitChangeError:");
    expect(result.stderr).toContain("fetch-depth: 0");
    expect(summary).toContain("Status: failed.");
    expect(summary).toContain("GitChangeError");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
