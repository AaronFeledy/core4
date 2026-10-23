import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { CI_PLATFORMS } from "../../../scripts/ci-platforms";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readmePath = resolve(repoRoot, "README.md");
const repositoryPath = resolve(repoRoot, "docs/contributing/repository.md");
const installPath = resolve(repoRoot, "docs/alpha-install-and-bug-reports.md");
const ciPath = resolve(repoRoot, "docs/contributing/ci.md");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const releasePolicy = (repository: string): string =>
  (
    repository.match(
      /^## Keep development and release artifacts distinct\n[\s\S]*?(?=^## |(?![\s\S]))/m,
    )?.[0] ?? ""
  ).replace(/\s+/g, " ");

const alphaPlatformScope = (ci: string): string =>
  ci.match(/^## Alpha platform scope\n[\s\S]*?(?=^## )/m)?.[0] ?? "";

describe("public alpha contract", () => {
  test("names Public Alpha 1 current when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).toContain("Public Alpha 1 is the current milestone");
  });

  test("marks pre-alpha and later Beta when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).toContain("pre-alpha");
    expect(status).toContain("Beta follows Alpha");
  });

  test("omits Current: Beta 1 when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).not.toContain("Current: Beta 1");
  });

  test("names 4.0.0-dev.N on the dev channel when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).toContain("4.0.0-dev.N");
    expect(status).toContain("`dev` channel");
  });

  test("omits 4.0.0-alpha.N when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).not.toContain("4.0.0-alpha.N");
  });

  test("lists every CI platform id in the Alpha install guide", async () => {
    const install = await readText(installPath);
    for (const platform of CI_PLATFORMS) {
      expect(install).toContain(platform.id);
    }
  });

  test("names Intel Mac Docker setup and the managed default in the install guide", async () => {
    const install = await readText(installPath);
    expect(install).toContain("Intel Mac (`darwin-x64`)");
    expect(install).toContain("lando setup --provider=docker");
    expect(install).toContain("Other supported platforms:");
    expect(install).toContain("the default is `lando`");
    expect(install).toContain("Lando-managed Podman");
  });

  test("finds recipes/drupal/README.mdx when the recipe file is checked", async () => {
    const exists = await Bun.file(resolve(repoRoot, "recipes/drupal/README.mdx")).exists();
    expect(exists).toBe(true);
  });

  test("documents the bundled Rails stack and non-interactive init in its executable recipe", async () => {
    const recipe = await readText(resolve(repoRoot, "recipes/rails/README.mdx"));
    const manifest = Bun.YAML.parse(await readText(resolve(repoRoot, "recipes/rails/recipe.yml"))) as {
      id: string;
      title: string;
      prompts: Array<{ default?: unknown }>;
      snapshot: { identity: { sourceKind: string } };
    };
    expect(manifest.id).toBe("rails");
    expect(manifest.snapshot.identity.sourceKind).toBe("bundled");
    expect(manifest.title).toBe("Ruby on Rails");
    expect(manifest.prompts.length).toBeGreaterThan(0);
    expect(manifest.prompts.every((prompt) => prompt.default !== undefined)).toBe(true);
    expect(recipe).toContain("PostgreSQL");
    expect(recipe).toContain("Redis");
    expect(recipe).toContain("lando rails");
    expect(recipe).toContain("lando bundle");
    expect(recipe).toContain("lando init --recipe rails --name={{appName}} --yes");
    expect(recipe).toContain("<Guide>");
  });

  test("requires an executable public Rails README and upgrades the builtin in contributor release policy", async () => {
    const criteria = releasePolicy(await readText(repositoryPath));
    expect(criteria).toContain("public Rails recipe uses an executable `README.mdx`");
    expect(criteria).toContain("`recipes/rails/`");
    expect(criteria).toContain(
      "Extend its existing built-in implementation rather than adding a duplicate recipe",
    );
  });

  test("finds the rails builtin stub when the stub manifest is checked", async () => {
    const exists = await Bun.file(resolve(repoRoot, "core/src/recipes/builtin/rails/manifest.ts")).exists();
    expect(exists).toBe(true);
  });

  test("finds recipes/rails/README.mdx when the recipe file is checked", async () => {
    const exists = await Bun.file(resolve(repoRoot, "recipes/rails/README.mdx")).exists();
    expect(exists).toBe(true);
  });

  test("mentions recipes/ when README is read", async () => {
    const readme = await readText(readmePath);
    expect(readme).toContain("recipes/");
  });

  test("defers signing installers and self-update when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).toContain("Signing");
    expect(status).toContain("installers");
    expect(status).toContain("self-update");
    expect(status.includes("later") || status.includes("do not ship")).toBe(true);
  });

  test("says GitHub prerelease ships unsigned binaries for all six compile targets in the install guide", async () => {
    const status = await readText(installPath);
    expect(status).toContain("unsigned");
    expect(status).toContain("GitHub prerelease");
    for (const id of [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "windows-x64",
      "windows-arm64",
    ] as const) {
      expect(status).toContain(id);
    }
    expect(status).not.toContain("Linux x64 only");
    expect(status).not.toContain("stay deferred");
  });

  test("names 4.0.0-dev.N when contributing CI docs are read", async () => {
    const ciDocs = await readText(resolve(repoRoot, "docs/contributing/ci.md"));
    expect(ciDocs).toContain("4.0.0-dev.N");
    expect(ciDocs).not.toContain("4.0.0-alpha.N");
  });

  test("requires live setup doctor Drupal and Rails on every compile target in CI acceptance", async () => {
    const criteria = alphaPlatformScope(await readText(ciPath));
    expect(criteria).toContain("all six compile targets");
    expect(criteria).toContain("Live `lando setup` and `lando doctor`");
    expect(criteria).toContain("Drupal canonical journey");
    expect(criteria).toContain("Rails canonical journey");
  });

  test("says compilation alone is not an exit in CI acceptance", async () => {
    const criteria = alphaPlatformScope(await readText(ciPath));
    expect(criteria).toContain("Compile smoke is not an Alpha exit");
  });

  test("says a roadmap rewrite is not an Alpha 1 exit in contributor release policy", async () => {
    const criteria = releasePolicy(await readText(repositoryPath));
    expect(criteria).toContain("A roadmap rewrite does not satisfy these criteria");
  });

  test("omits signed GA public artifact claims when contributor release policy is read", async () => {
    const status = releasePolicy(await readText(repositoryPath));
    expect(status).toContain("unsigned");
    expect(status).not.toContain("signed 4.0.0");
    expect(status).not.toMatch(/\bGA\b/);
    expect(status).not.toContain("Current: Beta 1");
  });

  test("drops Historical Alpha CI was Linux x64 only when contributing CI docs are read", async () => {
    const ciDocs = await readText(resolve(repoRoot, "docs/contributing/ci.md"));
    expect(ciDocs).not.toContain("Historical Alpha CI was Linux x64 only");
  });

  test("names six-target live gates when contributing CI Alpha platform scope is read", async () => {
    const scope = alphaPlatformScope(await readText(resolve(repoRoot, "docs/contributing/ci.md")));
    expect(scope).toContain("six compile targets");
    expect(scope).toContain("Compile smoke is not an Alpha exit");
    expect(scope).toContain("platform-readiness");
    expect(scope).toContain("drupal-journey");
    expect(scope).toContain("rails-journey");
    expect(scope).toContain("lando-virt");
    expect(scope).toContain("a missing runner is an error, not a skip");
  });

  test("keeps six-cell jobs in platform-readiness Drupal journey and Rails journey workflows", async () => {
    const readiness = await readText(resolve(repoRoot, ".github/workflows/platform-readiness.yml"));
    const drupal = await readText(resolve(repoRoot, ".github/workflows/drupal-journey.yml"));
    const rails = await readText(resolve(repoRoot, ".github/workflows/rails-journey.yml"));
    for (const platform of CI_PLATFORMS) {
      expect(readiness).toContain(`platform-readiness-${platform.id}:`);
      expect(drupal).toContain(`drupal-journey-${platform.id}:`);
      expect(rails).toContain(`rails-journey-${platform.id}:`);
    }
  });

  test("keeps Intel Mac fail-close docker remediation when provider-lando host-support is read", async () => {
    const hostSupport = await readText(resolve(repoRoot, "plugins/provider-lando/src/host-support.ts"));
    expect(hostSupport).toContain("rejectIntelMacHost");
    expect(hostSupport).toContain("lando setup --provider=docker");
    expect(hostSupport).toContain("LANDO_PROVIDER=docker");
  });
});
