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

  test("documents criteria 1-9 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain('Scenario id="release-pipeline-and-supply-chain" render={false}');
    expect(guide).toContain("core/test/build/linux-acceptance-criteria-1-9.test.ts");
    expect(guide).toContain("criteria 1-9 pass on the reference platform");
    expect(guide).toContain("SHA256SUMS, SBOM, SLSA, cosign verify-blob");
    expect(guide).toContain("UpdateLaunchProbeError rollback");
    expect(guide).toContain("UpdatePermissionError");
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

  test("documents criteria 15-19 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain('Scenario id="runtime-bytecode-aot" render={false}');
    expect(guide).toContain("FileSyncEngine creates accelerated app:start sessions");
    expect(guide).toContain("repeat app:start invocations reuse existing file-sync sessions");
    expect(guide).toContain("bun build ./core/bin/lando.ts --compile --bytecode");
    expect(guide).toContain("core/src/runtime/generated/layers/<level>.ts");

    expect(guide).toContain('Scenario id="performance-and-level-none" render={false}');
    expect(guide).toContain("guide-scenarios-linux-x64");
    expect(guide).toContain("perf-budget-linux-x64");
    expect(guide).toContain("compiled-binary e2e @smoke subset");
    expect(guide).toContain("bun run bench:tooling-hot-path -- --binary dist/lando");
    expect(guide).toContain("level-none invocations do not import @oclif/core");
    expect(guide).toContain("Context.Service");
  });

  test("documents criteria 1-9 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain('Scenario id="release-local-and-timing" render={false}');
    expect(guide).toContain("bun run release");
    expect(guide).toContain("local binary launches and reports version");
    expect(guide).toContain("single-platform release under 30 minutes");
    expect(guide).toContain("full-matrix release under 60 minutes");

    expect(guide).toContain('Scenario id="signing-and-supply-chain" render={false}');
    expect(guide).toContain("Linux binaries are covered by GPG-signed SHA256SUMS");
    expect(guide).toContain("CycloneDX SBOM artifacts");
    expect(guide).toContain("SLSA v1.0 provenance attestations");
    expect(guide).toContain("cosign verify-blob");

    expect(guide).toContain('Scenario id="self-update-safety" render={false}');
    expect(guide).toContain("signed update manifest verification");
    expect(guide).toContain("snapshot replacement and re-exec");
    expect(guide).toContain("UpdateLaunchProbeError");
    expect(guide).toContain("UpdatePermissionError");
    expect(guide).toContain("no silent elevation");
  });
});
