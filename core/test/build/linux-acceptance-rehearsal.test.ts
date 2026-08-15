import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = resolve(repoRoot, "docs/guides/release/linux-acceptance-rehearsal.mdx");

describe("Linux-x64 release acceptance rehearsal guide", () => {
  test("documents criteria 1-9 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain("core/test/build/linux-acceptance-criteria-1-9.test.ts");
    expect(guide).toContain("criteria 1-9 pass on the reference");
    expect(guide).toContain("SHA256SUMS, SBOM, SLSA, cosign verify-blob");
    expect(guide).toContain("UpdateLaunchProbeError");
    expect(guide).toContain("UpdatePermissionError");
  });

  test("documents criteria 20-27 proof surfaces without running host-mutating release work", async () => {
    const guide = await readFile(guidePath, "utf8");

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

    expect(guide).toContain("FileSyncEngine creates accelerated");
    expect(guide).toContain("repeat");
    expect(guide).toContain("app:start");
    expect(guide).toContain("reuse existing file-sync sessions");
    expect(guide).toContain(
      "bun run scripts/build-compiled-binary.ts --target linux-x64 --outfile ./dist/lando",
    );
    expect(guide).toContain("core/src/runtime/generated/layers/<level>.ts");

    expect(guide).toContain("guide-scenarios-linux-x64");
    expect(guide).toContain("perf-budget-linux-x64");
    expect(guide).toContain("compiled-binary e2e");
    expect(guide).toContain("@smoke");
    expect(guide).toContain("bun run bench:tooling-hot-path -- --binary dist/lando");
    expect(guide).toContain("level-none invocations do not import `@oclif/core`");
    expect(guide).toContain("Context.Service");
  });
});
