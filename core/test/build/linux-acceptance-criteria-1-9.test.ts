import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBunTest = async (testPath: string, nameFilter: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", testPath, "-t", nameFilter],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const expectPassingSpotCheck = async (testPath: string, nameFilter: string): Promise<void> => {
  const result = await runBunTest(testPath, nameFilter);
  expect(
    result.exitCode,
    `expected ${testPath} -t "${nameFilter}" to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
};

const longHarness = { timeout: 180_000 };

describe("§17.9 acceptance criteria 1-9 on linux-x64", () => {
  test(
    "criterion 1: release rehearsal writes checksum manifests and compiled binary reports version on linux-x64",
    async () => {
      await expectPassingSpotCheck(
        "core/test/scripts/release.test.ts",
        "local rehearsal skips credential-gated work but still writes manifests",
      );
      await expectPassingSpotCheck(
        "core/test/build/ci-workflow.test.ts",
        "rehearses the distribution flow on Linux x64 without publishing",
      );
      if (isLinuxX64) {
        await expectPassingSpotCheck(
          "core/test/build/compile.test.ts",
          "uses bytecode for the canonical compiled entry",
        );
      }
    },
    longHarness,
  );

  test("criterion 2: records gated timing evidence for release compile and CI job budgets", async () => {
    const [nightly, ci, releaseTest] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/nightly.yml"), "utf8"),
      readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repoRoot, "core/test/scripts/release.test.ts"), "utf8"),
    ]);

    expect(nightly).toContain("distribution-rehearsal-linux-x64:");
    expect(nightly).toContain("timeout-minutes:");
    expect(nightly).toContain("./dist/bundle/lando-linux-x64 --version");
    expect(ci).toContain("build-linux-x64:");
    expect(ci).toContain("timeout-minutes:");
    expect(releaseTest).toContain("budget 600000ms");
    expect(releaseTest).toContain("ReleaseCompileBudgetError");

    const spec = await readFile(resolve(repoRoot, "spec/15-binary-build-and-release.md"), "utf8");
    expect(spec).toContain("under 30 minutes for a single-platform release");
    expect(spec).toContain("under 60 minutes for a full-matrix release");
  });

  test(
    "criteria 3-5: linux-x64 signing policy, SBOM, SLSA, SHA256SUMS, and cosign verify-blob",
    async () => {
      const releaseSpotChecks: ReadonlyArray<string> = [
        "writes checksum manifests for every release binary and GPG-signs them in the manifest stage",
        "cosign-signs and verifies SHA256SUMS in the provenance stage",
        "generates CycloneDX SBOMs for release artifacts and links them from the manifest",
        "generates and signs SLSA provenance for release artifacts",
        "binary verification signs every release binary and writes release-note commands",
      ];
      for (const filter of releaseSpotChecks) {
        await expectPassingSpotCheck("core/test/scripts/release.test.ts", filter);
      }
    },
    longHarness,
  );

  test(
    "criteria 6-9: signed update manifest verification and POSIX self-update safety",
    async () => {
      const updateSpotChecks: ReadonlyArray<string> = [
        "verifies the sibling signature and certificate before parsing or trusting manifest fields",
        "POSIX self-update replaces the binary atomically and re-execs with preserved argv and env",
        "POSIX self-update restores the backup when the replaced binary fails its launch probe",
        "POSIX self-update reports rollback EACCES as UpdatePermissionError",
      ];
      for (const filter of updateSpotChecks) {
        await expectPassingSpotCheck("core/test/cli/update-manifest.test.ts", filter);
      }
    },
    longHarness,
  );
});
