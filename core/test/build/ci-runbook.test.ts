import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runbookPath = resolve(repoRoot, "docs/ci-runbook.md");
const readmePath = resolve(repoRoot, "README.md");
const githubPath = resolve(repoRoot, ".github");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const listPrTemplates = async (): Promise<ReadonlyArray<string>> => {
  const rootEntries = await readdir(githubPath, { withFileTypes: true });
  const templates = rootEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().includes("pull_request_template"))
    .map((entry) => resolve(githubPath, entry.name));
  const templateDir = rootEntries.find(
    (entry) => entry.isDirectory() && entry.name === "PULL_REQUEST_TEMPLATE",
  );

  if (templateDir === undefined) return templates;

  const templateEntries = await readdir(resolve(githubPath, templateDir.name), { withFileTypes: true });
  return [
    ...templates,
    ...templateEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => resolve(githubPath, templateDir.name, entry.name)),
  ];
};

describe("ci runbook", () => {
  test("documents local commands and failure artifacts", async () => {
    const runbook = await readText(runbookPath);

    expect(runbook).toContain("bun run typecheck");
    expect(runbook).toContain("bun run lint");
    expect(runbook).toContain("bun test --filter='!*.integration.test.ts'");
    expect(runbook).toContain("bun run build");
    expect(runbook).toContain("LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario");
    expect(runbook).toContain("podman system service --time=0 unix:///tmp/podman.sock");
    expect(runbook).toContain("Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64");
    expect(runbook).toContain(
      "Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics",
    );
  });

  test("links the runbook from README and pull request templates", async () => {
    const readme = await readText(readmePath);
    const templates = await listPrTemplates();

    expect(readme).toContain("docs/ci-runbook.md");
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      expect(await readText(template)).toContain("docs/ci-runbook.md");
    }
  });
});
