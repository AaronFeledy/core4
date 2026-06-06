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
    expect(runbook).toContain("bun run check:renderer-boundary");
    expect(runbook).toContain("bun run test:unit");
    expect(runbook).toContain("Every platform cell runs the fork-safe portable static gates");
    expect(runbook).toContain(
      "Only the `linux-x64` static-checks cell runs the full current static test suite",
    );
    expect(runbook).toContain("static-checks-scope");
    expect(runbook).toContain("US-189");
    expect(runbook).toContain("darwin-arm64");
    expect(runbook).toContain("build-windows-x64");
    expect(runbook).toContain("bun run build");
    expect(runbook).toContain("CI pins Bun via `.bun-version`");
    expect(runbook).toContain("Provider integration tests intentionally stay serial");
    expect(runbook).toContain("::notice title=ci-timing::");
    expect(runbook).toContain("timeout cap");
    expect(runbook).toContain("BUN_INSTALL_GLOBAL_STORE=1 bun install --linker=isolated");
    expect(runbook).toContain("LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario");
    expect(runbook).toContain("podman system service --time=0 unix:///tmp/podman.sock");
    expect(runbook).toContain("Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64");
    expect(runbook).toContain("npm beta package publishing");
    expect(runbook).toContain("npm trusted publishing through GitHub OIDC (`id-token: write`)");
    expect(runbook).toContain("does not use a local `NPM_TOKEN` or `NODE_AUTH_TOKEN` path");
    expect(runbook).toContain("bun run --filter='@lando/sdk' build");
    expect(runbook).toContain("bun run --filter='@lando/container-runtime' build");
    expect(runbook).toContain("bun run --filter='@lando/core' build:manifest");
    expect(runbook).toContain("`@lando/sdk`, `@lando/container-runtime`, `@lando/core`");
    expect(runbook).toContain("npm install @lando/core@next");
    expect(runbook).toContain("retires the old `dev` dist-tag");
    expect(runbook).toContain("`latest` dist-tag is unchanged");
    expect(runbook).toContain(
      "Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics-linux-x64",
    );
    expect(runbook).toContain("Weekly provider matrix");
    expect(runbook).toContain("The advisory `provider-matrix` workflow runs weekly");
    expect(runbook).toContain("Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, and OrbStack");
    expect(runbook).toContain("provider-matrix-diagnostics-<cell>");
    expect(runbook).toContain("not listed under branch protection");
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
