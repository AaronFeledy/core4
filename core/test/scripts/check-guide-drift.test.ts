import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type GuideDriftGateOptions, runGuideDriftGate } from "../../../scripts/check-guide-drift.ts";
import type { HomeGuideEntry } from "../../../scripts/guides/home-guide-registry.ts";

const roots: string[] = [];

const demoGuide = `---
id: demo
provider: test
---

# Demo

<Guide>
  <Scenario id="runs">
    <Step name="run">
      <Run command="version" />
    </Step>
  </Scenario>
</Guide>
`;

const put = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const git = async (root: string, ...args: string[]): Promise<void> => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
};

const commit = (root: string, message: string): Promise<void> =>
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );

const fixture = async (files: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-"));
  roots.push(root);
  await put(root, "docs/guides/demo.mdx", demoGuide);
  await put(root, "src/covered.ts", "export const a = 1;\n");
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await commit(root, "base");
  return root;
};

const entries: readonly HomeGuideEntry[] = [
  { feature: "demo", guide: "docs/guides/demo.mdx", sources: ["src/*.ts"] },
];

const literalEntries: readonly HomeGuideEntry[] = [
  { feature: "demo", guide: "docs/guides/demo.mdx", sources: ["src/covered.ts"] },
];

const gate = (
  root: string,
  env: NodeJS.ProcessEnv = {},
  injected = entries,
): ReturnType<typeof runGuideDriftGate> =>
  runGuideDriftGate({
    root,
    env: { GUIDE_DRIFT_BASE_REF: "HEAD", ...env },
    args: [],
    entries: injected,
  } satisfies GuideDriftGateOptions);

const skipBody = `Guide-Coverage-Skip: ${"intentional internal refactor with no guide change"}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a covered path without a touch to the home guide fails", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.guide-not-touched");
  expect(result.stderr).toContain('"src/covered.ts"');
  expect(result.stderr).toContain("docs/guides/demo.mdx");
  expect(result.stderr).toContain('"docs/guides/demo/fixtures/"');
  expect(result.stderr).not.toContain("<guideId>");
  expect(result.stderr).toContain("bun run test:affected --run");
  expect(result.stderr).toContain("GUIDE_DRIFT_PR_BODY");
});

test("the remediation resolves the fixtures directory from the guide's frontmatter id", async () => {
  const root = await fixture({
    "docs/guides/services/renamed.mdx": demoGuide.replace("id: demo", "id: actual-id"),
    "src/nested/covered.ts": "export const a = 1;\n",
  });
  await put(root, "src/nested/covered.ts", "export const a = 2;\n");

  const result = await gate(root, {}, [
    { feature: "nested", guide: "docs/guides/services/renamed.mdx", sources: ["src/nested/*.ts"] },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"docs/guides/actual-id/fixtures/"');
  expect(result.stderr).not.toContain("docs/guides/services/renamed/fixtures/");
  expect(result.stderr).not.toContain("<guideId>");
});

test("touching the home guide satisfies the covered path", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo.mdx", `${demoGuide}\nMore.\n`);

  const result = await gate(root);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"src/covered.ts" -> demo: docs/guides/demo.mdx touched');
});

test("a guide-only change passes with no covered path changed", async () => {
  const root = await fixture();
  await put(root, "docs/guides/demo.mdx", `${demoGuide}\nMore.\n`);

  const result = await gate(root);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("no covered paths changed");
});

test("a fixture change beside the guide satisfies the covered path", async () => {
  const root = await fixture({ "docs/guides/demo/fixtures/app/.lando.yml": "name: demo\n" });
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo/fixtures/app/.lando.yml", "name: demo\nservices: {}\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(0);
});

test("a .cases.ts change beside the guide is not a guide change", async () => {
  const root = await fixture({ "docs/guides/demo/example.cases.ts": "export const cases = [];\n" });
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo/example.cases.ts", "export const cases = [1];\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.guide-not-touched");
});

test("a different guide does not satisfy the covered path", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/other.mdx", demoGuide.replace("id: demo", "id: other"));

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.guide-not-touched");
});

test("a staged rename under a glob reports both paths", async () => {
  const root = await fixture();
  await git(root, "mv", "src/covered.ts", "src/renamed.ts");

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.guide-not-touched");
  expect(result.stderr).toContain('"src/covered.ts"');
  expect(result.stderr).toContain('"src/renamed.ts"');
});

test("a staged rename of a literally declared source fails the map, skip or not", async () => {
  const root = await fixture();
  await git(root, "mv", "src/covered.ts", "src/renamed.ts");

  const withoutSkip = await gate(root, {}, literalEntries);
  expect(withoutSkip.exitCode).toBe(1);
  expect(withoutSkip.stderr).toContain("registry.unmatched-source");

  const withSkip = await gate(root, { GUIDE_DRIFT_PR_BODY: skipBody }, literalEntries);
  expect(withSkip.exitCode).toBe(1);
  expect(withSkip.stderr).toContain("registry.unmatched-source");
  expect(withSkip.stderr).toContain("does not waive");
});

test("an empty map fails even with a valid skip", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, { GUIDE_DRIFT_PR_BODY: skipBody }, []);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("registry.empty");
});

test("a valid skip exempts the unsatisfied feature and reports it", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, { GUIDE_DRIFT_PR_BODY: skipBody });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Guide-Coverage-Skip accepted:");
  expect(result.stdout).toContain("demo");
  expect(result.stdout).toContain("exempted by Guide-Coverage-Skip");
});

test("a 23-character skip reason fails", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, { GUIDE_DRIFT_PR_BODY: `Guide-Coverage-Skip: ${"x".repeat(23)}` });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.skip-reason-too-short");
});

test("a skip reason of exactly the minimum length is accepted", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, {
    GUIDE_DRIFT_PR_BODY: `Guide-Coverage-Skip: ${"x".repeat(24)}`,
  });
  expect(result.exitCode).toBe(0);
});

test("a head SHA that is not a commit fails closed with a GitChangeError", async () => {
  const root = await fixture();

  const result = await runGuideDriftGate({
    root,
    env: { GUIDE_DRIFT_BASE_SHA: await headSha(root), GUIDE_DRIFT_HEAD_SHA: "not-an-object" },
    args: [],
    entries,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("GitChangeError");
  expect(result.stderr).toContain("fetch-depth: 0");
});

test("one of the two comparison SHAs without the other fails closed", async () => {
  const root = await fixture();

  const result = await runGuideDriftGate({
    root,
    env: { GUIDE_DRIFT_BASE_SHA: await headSha(root) },
    args: [],
    entries,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("GUIDE_DRIFT_HEAD_SHA");
  expect(result.stdout).not.toContain("passed");
});

const headSha = async (root: string): Promise<string> => {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return out.trim();
};

const summaryRun = async (
  root: string,
  env: NodeJS.ProcessEnv,
  injected = entries,
): Promise<{ readonly result: Awaited<ReturnType<typeof runGuideDriftGate>>; readonly summary: string }> => {
  const summaryPath = join(root, "step-summary.md");
  await writeFile(summaryPath, "");
  const result = await gate(root, { GITHUB_STEP_SUMMARY: summaryPath, ...env }, injected);
  return { result, summary: await Bun.file(summaryPath).text() };
};

test("pass output and summary name the comparison, the covered path, its feature, and the guide", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo.mdx", `${demoGuide}\nMore.\n`);

  const { result, summary } = await summaryRun(root, {});
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("merge base ");
  expect(result.stdout).toContain('"src/covered.ts" -> demo: docs/guides/demo.mdx touched');
  expect(summary).toContain("Status: passed.");
  expect(summary).toContain('"src/covered.ts" -> demo: docs/guides/demo.mdx touched');
});

test("an unrelated change reports the comparison count instead of a covered path", async () => {
  const root = await fixture({ "docs/notes.txt": "one\n" });
  await put(root, "docs/notes.txt", "two\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("no covered paths changed (1 changed paths compared)");
});

test("a valid skip reports its reason and exactly the exempted features, not the satisfied ones", async () => {
  const otherGuide = demoGuide.replace("id: demo", "id: other");
  const root = await fixture({
    "docs/guides/other.mdx": otherGuide,
    "src/demo/covered.ts": "export const a = 1;\n",
    "src/other/covered.ts": "export const a = 1;\n",
  });
  const twoEntries: readonly HomeGuideEntry[] = [
    { feature: "demo", guide: "docs/guides/demo.mdx", sources: ["src/demo/*.ts"] },
    { feature: "other", guide: "docs/guides/other.mdx", sources: ["src/other/*.ts"] },
  ];
  await put(root, "src/demo/covered.ts", "export const a = 2;\n");
  await put(root, "src/other/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo.mdx", `${demoGuide}\nMore.\n`);

  const { result, summary } = await summaryRun(root, { GUIDE_DRIFT_PR_BODY: skipBody }, twoEntries);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Guide-Coverage-Skip accepted:");
  expect(result.stdout).toContain("intentional internal refactor with no guide change");
  expect(result.stdout).toContain("-> other:");
  expect(result.stdout).not.toContain("-> other: docs/guides/other.mdx touched");
  expect(result.stdout).not.toContain('"src/demo/covered.ts" -> demo: docs/guides/demo.mdx (exempted');

  const exempted =
    summary.split("### Exempted by Guide-Coverage-Skip")[1]?.split("### Changed Files")[0] ?? "";
  expect(exempted).toContain('"src/other/covered.ts" -> other: docs/guides/other.mdx');
  expect(exempted).not.toContain("-> demo:");
});

test("baseline growth fails with a valid skip, and the diagnostic precedes the skip status", async () => {
  const root = await fixture({ "scripts/guides/container-command-lint.ts": "export {};\n" });
  const baselinePath = join(root, "scripts/guides/container-command-baseline.json");
  await writeFile(baselinePath, JSON.stringify({ "docs/guides/demo.mdx": ["lando exec app -- php -m"] }));
  await git(root, "add", ".");
  await commit(root, "baseline");
  await writeFile(
    baselinePath,
    JSON.stringify({
      "docs/guides/demo.mdx": ["lando exec app -- php -m"],
      "docs/guides/added.mdx": ["lando logs -s app"],
    }),
  );
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const { result, summary } = await summaryRun(root, { GUIDE_DRIFT_PR_BODY: skipBody });
  expect(result.exitCode).toBe(1);
  const diagnostic = result.stderr.indexOf("guide.container-command.e2e-coverage");
  const skipStatus = result.stderr.indexOf("Guide-Coverage-Skip accepted:");
  expect(diagnostic).toBeGreaterThanOrEqual(0);
  expect(skipStatus).toBeGreaterThan(diagnostic);
  expect(result.stderr).toContain("does not waive");
  expect(summary.indexOf("guide.container-command.e2e-coverage")).toBeLessThan(
    summary.indexOf("### Exempted by Guide-Coverage-Skip"),
  );
});

test("the failure text gives both the PR-body line and its local preview command", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Guide-Coverage-Skip:");
  expect(result.stderr).toContain(
    "GUIDE_DRIFT_PR_BODY='Guide-Coverage-Skip: <reason>' bun run check:guide-drift",
  );
  expect(result.stderr).toContain("bun run test:affected --run");
});

test("an explicit --base with the comparison SHAs is an error", async () => {
  const root = await fixture();
  const sha = await headSha(root);

  const result = await runGuideDriftGate({
    root,
    env: { GUIDE_DRIFT_BASE_SHA: sha, GUIDE_DRIFT_HEAD_SHA: sha },
    args: ["--base", "HEAD"],
    entries,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--base HEAD");
  expect(result.stderr).toContain("GUIDE_DRIFT_BASE_SHA");
  expect(result.stderr).toContain("drop --base");
});

test("the CI SHA pair still compares the two commits", async () => {
  const root = await fixture();
  const sha = await headSha(root);

  const result = await runGuideDriftGate({
    root,
    env: { GUIDE_DRIFT_BASE_SHA: sha, GUIDE_DRIFT_HEAD_SHA: sha },
    args: [],
    entries,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("no covered paths changed");
});

test("a deleted path that matches two features' globs requires both guides", async () => {
  const otherGuide = demoGuide.replace("id: demo", "id: other");
  const root = await fixture({
    "docs/guides/other.mdx": otherGuide,
    "src/x.ts": "export const gone = 1;\n",
    "src/legacy/x.ts": "export const legacy = 1;\n",
  });
  const twoEntries: readonly HomeGuideEntry[] = [
    { feature: "nested-sources", guide: "docs/guides/demo.mdx", sources: ["src/**/x.ts"] },
    { feature: "flat-sources", guide: "docs/guides/other.mdx", sources: ["src/*.ts"] },
  ];
  await rm(join(root, "src/x.ts"));

  const result = await gate(root, {}, twoEntries);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('drift.guide-not-touched: "src/x.ts" changed for feature "flat-sources"');
  expect(result.stderr).toContain('drift.guide-not-touched: "src/x.ts" changed for feature "nested-sources"');
});

test("a .cases.ts file under the guide's fixtures does not count as touching the guide", async () => {
  const root = await fixture({
    "docs/guides/demo/fixtures/example.cases.ts": "export const cases = [];\n",
  });
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await put(root, "docs/guides/demo/fixtures/example.cases.ts", "export const cases = [1];\n");

  const result = await gate(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.guide-not-touched");
});

test("more than one skip line is ambiguous and fails without exempting anything", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, {
    GUIDE_DRIFT_PR_BODY: `Reviewed.\n${skipBody}\n${skipBody}\n`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("drift.skip-ambiguous");
  expect(result.stderr).toContain('2 "Guide-Coverage-Skip:" lines');
  expect(result.stderr).toContain('line 2: "intentional internal refactor with no guide change"');
  expect(result.stderr).toContain('line 3: "intentional internal refactor with no guide change"');
  expect(result.stderr).not.toContain("Guide-Coverage-Skip accepted:");
  expect(result.stderr).toContain("drift.guide-not-touched");
});

test("a mapped guide that does not exist is a map failure, not a crash", async () => {
  const root = await fixture();
  await put(root, "src/covered.ts", "export const a = 2;\n");

  const result = await gate(root, {}, [
    { feature: "gone", guide: "docs/guides/gone.mdx", sources: ["src/*.ts"] },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("registry.unknown-guide");
  expect(result.stderr).not.toContain("ENOENT");
});
