import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = resolve(repoRoot, "docs/guides/release/linux-acceptance-rehearsal.mdx");
const guideIndexPath = resolve(repoRoot, "docs/guides/INDEX.md");
const prdPath = resolve(repoRoot, "spec/beta-1/prd-beta-1-11-library-and-acceptance.md");

describe("Linux-x64 release acceptance rehearsal guide", () => {
  test("is declared by the PRD and shipped in the guide coverage index", async () => {
    const [guide, guideIndex, prd] = await Promise.all([
      readFile(guidePath, "utf8"),
      readFile(guideIndexPath, "utf8"),
      readFile(prdPath, "utf8"),
    ]);

    expect(prd).toContain("`docs/guides/release/linux-acceptance-rehearsal.mdx`");
    expect(guideIndex).toContain(
      "| PRD-11 | US-276, US-277, US-278, US-279 | Linux-x64 §17.9 acceptance rehearsal | `docs/guides/release/linux-acceptance-rehearsal.mdx` | Shipped |",
    );
    expect(guide).toContain("id: release-linux-acceptance-rehearsal");
  });

  test("documents criteria 20-27 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain('Scenario id="external-plugin-loading" render={false}');
    expect(guide).toContain("External ESM plugins load from an absolute file URL");
    expect(guide).toContain(
      "External TypeScript plugin entries load through Bun's native TypeScript importer",
    );
    expect(guide).toContain("PluginLoadError");
    expect(guide).toContain("bun run codegen:check");
    expect(guide).toContain("core/build.config.ts#bundledPlugins");
    expect(guide).toContain("lando init --recipe <id>");
  });
});
