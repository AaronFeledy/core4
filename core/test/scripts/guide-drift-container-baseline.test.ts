import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGuideDriftOnDisk, formatDriftDiagnostic } from "../../../scripts/check-guide-drift.ts";
import {
  CONTAINER_COMMAND_BASELINE_PATH,
  addedContainerCommandEntries,
} from "../../../scripts/guides/container-command-baseline.ts";

const oldPage = "docs/guides/old.mdx";
const newPage = "docs/guides/new.mdx";
const command = "lando exec app -- php -m";
const added = "lando logs -s app";
const base = { [oldPage]: [command] };

test.each([
  {
    name: "rejects an added command",
    current: { [oldPage]: [command, added] },
    expected: [{ path: oldPage, command: added }],
  },
  { name: "accepts a removed command", current: {}, expected: [] },
  { name: "accepts unchanged entries", current: base, expected: [] },
  {
    name: "carries a command from a removed guide",
    current: { [newPage]: [command] },
    removed: [oldPage],
    expected: [],
  },
  {
    name: "rejects a new command on a moved guide",
    current: { [newPage]: [command, added] },
    removed: [oldPage],
    expected: [{ path: newPage, command: added }],
  },
  {
    name: "rejects a copy while the original guide still exists",
    current: { [newPage]: [command] },
    expected: [{ path: newPage, command }],
  },
  {
    name: "does not let one moved entry become two",
    current: { [newPage]: [command], "recipes/demo/README.mdx": [command] },
    removed: [oldPage],
    expected: [{ path: "recipes/demo/README.mdx", command }],
  },
  {
    name: "does not carry an entry that remains at the old path",
    current: { ...base, [newPage]: [command] },
    removed: [oldPage],
    expected: [{ path: newPage, command }],
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

test.each([
  {
    name: "allows the first baseline only when the base has neither baseline nor rule",
    onBase: "neither",
    bootstrap: true,
    expected: [],
  },
  {
    name: "treats a missing baseline as empty if the base already has the rule",
    onBase: "rule",
    bootstrap: false,
    expected: [
      [oldPage, command],
      [newPage, added],
    ],
  },
  {
    name: "rejects working-tree growth when a baseline exists even without the rule",
    onBase: "baseline",
    bootstrap: false,
    expected: [[newPage, added]],
  },
] as const)("$name", async ({ onBase, bootstrap, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-baseline-"));
  try {
    await mkdir(join(root, "scripts/guides"), { recursive: true });
    await mkdir(join(root, "docs/guides"), { recursive: true });
    await Bun.write(join(root, "docs/guides/prd-sources.json"), '{"directories":[],"files":[]}');
    const baselineFile = join(root, CONTAINER_COMMAND_BASELINE_PATH);
    if (onBase === "baseline") await Bun.write(baselineFile, JSON.stringify(base));
    if (onBase === "rule")
      await Bun.write(join(root, "scripts/guides/container-command-lint.ts"), "export {};\n");
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
    await Bun.write(baselineFile, JSON.stringify({ ...base, [newPage]: [added] }));

    const result = await checkGuideDriftOnDisk(root, {
      baseRef: "HEAD",
      prBody: "Guide-Coverage-Skip: No guide changes are needed for this internal refactor.",
    });

    expect(result.baselineBootstrap ?? false).toBe(bootstrap);
    expect(result.diagnostics.map(formatDriftDiagnostic)).toEqual(
      expected.map(([path, argv]) =>
        expect.stringContaining(
          `${CONTAINER_COMMAND_BASELINE_PATH}: guide.container-command.e2e-coverage: ${path}: \`${argv}\``,
        ),
      ),
    );
    if (expected.length > 0) expect(result.skip).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
