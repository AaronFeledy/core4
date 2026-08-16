import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("docs workspace", () => {
  test("registers the docs workspace and root build script", async () => {
    // Given the root package manifest
    const rootPackage: unknown = await Bun.file(resolve(repoRoot, "package.json")).json();

    // When its workspace and script configuration is inspected
    // Then docs is a workspace with the generated-reference build entrypoint
    expect(rootPackage).toMatchObject({
      workspaces: expect.arrayContaining(["docs"]),
      scripts: {
        "docs:build": "bun run codegen && bun run --filter='@lando/docs' build",
      },
    });
  });

  test("declares the private Astro package contract", async () => {
    // Given the expected docs package manifest path
    const manifest = Bun.file(resolve(repoRoot, "docs/package.json"));

    // When checking the workspace manifest
    const exists = await manifest.exists();

    // Then it exists with the required package identity and commands
    expect(exists).toBe(true);
    if (!exists) return;
    const docsPackage: unknown = await manifest.json();
    expect(docsPackage).toMatchObject({
      name: "@lando/docs",
      private: true,
      type: "module",
      scripts: {
        build: "astro build",
        dev: "astro dev",
        preview: "astro preview",
      },
    });
  });

  test("ignores Astro's generated cache", async () => {
    // Given the repository ignore rules
    const ignoreRules = await Bun.file(resolve(repoRoot, ".gitignore")).text();

    // When the rules are split into exact entries
    const entries = ignoreRules.split("\n");

    // Then Astro's workspace cache is ignored
    expect(entries).toContain("docs/.astro/");
  });

  test("publishes the static site to the GitHub Pages project URL", async () => {
    const astroConfig = await Bun.file(resolve(repoRoot, "docs/astro.config.mjs")).text();

    expect(astroConfig).toContain('site: "https://aaronfeledy.github.io"');
    expect(astroConfig).toContain('base: "/core4/"');
  });
});
