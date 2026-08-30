import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { CI_PLATFORMS } from "../../../scripts/ci-platforms";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readmePath = resolve(repoRoot, "README.md");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const statusSection = (readme: string): string =>
  readme.match(/^## Status & roadmap\n[\s\S]*?(?=^## )/m)?.[0] ?? "";

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
    expect(status).toContain("bundled for Alpha 1");
    expect(status).toContain("id `rails`");
    expect(status).toContain("`recipes/rails/`");
    expect(status).toContain("upgraded rather than duplicated");
    expect(status).toContain("Ruby/Rails");
    expect(status).toContain("PostgreSQL");
    expect(status).toContain("Redis");
    expect(status).toContain("Tooling is `rails` and `bundle`");
    expect(status).toContain("non-interactive default");
    expect(status).toContain("README.mdx");
    expect(status).not.toContain("already ships as a public recipe at `recipes/rails`");
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
});
