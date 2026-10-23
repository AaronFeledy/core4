import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { CI_PLATFORMS } from "../../../scripts/ci-platforms";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readmePath = resolve(repoRoot, "README.md");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const statusSection = (readme: string): string =>
  readme.match(/^## Status & roadmap\n[\s\S]*?(?=^## )/m)?.[0] ?? "";

const alphaCompletionCriteria = (readme: string): string => {
  const contributing = readme.match(/^## Contributing\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? "";
  return contributing.match(/^### Alpha completion criteria\n[\s\S]*?(?=^#{1,3} |(?![\s\S]))/m)?.[0] ?? "";
};

const alphaPlatformScope = (ci: string): string =>
  ci.match(/^## Alpha platform scope\n[\s\S]*?(?=^## )/m)?.[0] ?? "";

describe("public alpha contract", () => {
  test("names Public Alpha 1 current when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("Public Alpha 1 is current");
  });

  test("marks pre-alpha and later Beta when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("pre-alpha");
    expect(status).toContain("Beta is later");
  });

  test("omits Current: Beta 1 when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).not.toContain("Current: Beta 1");
  });

  test("names 4.0.0-dev.N on the dev channel when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("4.0.0-dev.N");
    expect(status.includes("on the `dev` channel") || status.includes("`dev` channel")).toBe(true);
  });

  test("omits 4.0.0-alpha.N when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).not.toContain("4.0.0-alpha.N");
  });

  test("lists every CI platform id when README is read", async () => {
    const readme = await readText(readmePath);
    for (const platform of CI_PLATFORMS) {
      expect(readme).toContain(platform.id);
    }
  });

  test("names darwin-x64 Docker live path and lando default when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("darwin-x64");
    expect(status).toContain("Docker is the live path");
    expect(status).toContain("default provider stays `lando`");
  });

  test("finds recipes/drupal/README.mdx when the recipe file is checked", async () => {
    const exists = await Bun.file(resolve(repoRoot, "recipes/drupal/README.mdx")).exists();
    expect(exists).toBe(true);
  });

  test("names rails as a bundled Alpha 1 recipe when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("Rails is bundled for Alpha 1 as `rails`");
    expect(status).toContain("`recipes/rails/`");
    expect(status).toContain("Ruby/Rails");
    expect(status).toContain("PostgreSQL");
    expect(status).toContain("Redis");
    expect(status).toContain("`rails` and `bundle` tooling");
    expect(status).toContain("non-interactive default");
    expect(status).not.toContain("already ships as a public recipe at `recipes/rails`");
  });

  test("requires an executable public Rails README and upgrades the builtin in Alpha completion criteria", async () => {
    const criteria = alphaCompletionCriteria(await readText(readmePath));
    expect(criteria).toContain("public Rails recipe uses an executable `README.mdx`");
    expect(criteria).toContain("existing builtin implementation is upgraded rather than duplicated");
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

  test("defers signing installers and self-update when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
    expect(status).toContain("signing");
    expect(status).toContain("installers");
    expect(status).toContain("self-update");
    expect(status.includes("later") || status.includes("do not ship")).toBe(true);
  });

  test("says GitHub prerelease ships unsigned binaries for all six compile targets when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
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

  test("requires live setup doctor Drupal and Rails on every compile target in Alpha completion criteria", async () => {
    const criteria = alphaCompletionCriteria(await readText(readmePath));
    expect(criteria).toContain("Alpha 1 is complete only when every compile target passes");
    expect(criteria).toContain("live `lando setup`");
    expect(criteria).toContain("live `lando doctor`");
    expect(criteria).toContain("live canonical Drupal and Rails journeys");
  });

  test("says compilation alone is not an exit in Alpha completion criteria", async () => {
    const criteria = alphaCompletionCriteria(await readText(readmePath));
    expect(criteria).toContain("Compilation alone is not enough");
  });

  test("says a roadmap rewrite is not an Alpha 1 exit in Alpha completion criteria", async () => {
    const criteria = alphaCompletionCriteria(await readText(readmePath));
    expect(criteria).toContain("a roadmap rewrite does not meet these criteria");
  });

  test("omits signed GA public artifact claims when Status is read", async () => {
    const status = statusSection(await readText(readmePath));
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
