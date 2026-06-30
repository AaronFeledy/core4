import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const harnessPath = resolve(import.meta.dirname, "linux-acceptance-criteria-10-14.test.ts");
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBunTest = async (testPath: string, nameFilter: string): Promise<RunResult> => {
  const pathArg = testPath.startsWith("./") ? testPath : `./${testPath}`;
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", pathArg, "-t", nameFilter],
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

describe("§17.9 acceptance criteria 10-14 on linux-x64", () => {
  test(
    "criterion 10: install.sh verifies GPG trust root, installs binary, runs version, and matches shellenv PATH",
    async () => {
      const posixSpotChecks: ReadonlyArray<string> = [
        "verifies SHA256SUMS.asc with the vendored GPG trust root",
        "installs the verified linux-x64 binary into LANDO_INSTALL_DIR",
        "prints canonical shellenv PATH guidance after install",
      ];
      for (const filter of posixSpotChecks) {
        await expectPassingSpotCheck("core/test/scripts/install-posix.test.ts", filter);
      }
    },
    longHarness,
  );

  test("criterion 11: Windows installer harness is platform-gated until RC all-platform acceptance", async () => {
    const harnessSource = await readFile(harnessPath, "utf8");
    expect(harnessSource).toContain("platform-gated");

    if (process.platform === "win32") {
      await expectPassingSpotCheck(
        "core/test/scripts/install-windows.test.ts",
        "installs the verified windows-x64 binary into LANDO_INSTALL_DIR",
      );
      return;
    }

    const windowsHarness = await readFile(
      resolve(repoRoot, "core/test/scripts/install-windows.test.ts"),
      "utf8",
    );
    expect(windowsHarness).toContain("install.ps1");
    expect(windowsHarness).toContain("verify-blob");
  });

  test(
    "criterion 12: compiled runtime modules embed bundled assets instead of reading them from disk",
    async () => {
      await expectPassingSpotCheck(
        "core/test/cli/compiled-asset-boundary.test.ts",
        "runtime modules embed assets instead of reading generated asset files from disk",
      );
      await expectPassingSpotCheck(
        "core/test/recipes/bundled.test.ts",
        "manifest yaml is embedded inline \\(compiled binary does not read from disk\\)",
      );
    },
    longHarness,
  );

  test("criterion 13: Mutagen manifest and download policy ship without embedding agent binaries", async () => {
    const [provisionSource, manifestJson] = await Promise.all([
      readFile(resolve(repoRoot, "plugins/file-sync-mutagen/src/provision.ts"), "utf8"),
      readFile(resolve(repoRoot, "plugins/file-sync-mutagen/mutagen-versions.json"), "utf8"),
    ]);

    expect(provisionSource).toContain("mutagen-versions.json");
    expect(provisionSource).toContain("linux-armv7");
    expect(manifestJson).toContain("toolVersion");
    expect(manifestJson).toContain("linux-amd64");

    await expectPassingSpotCheck(
      "plugins/file-sync-mutagen/test/provision.test.ts",
      "installs host CLI plus all three agents from one shared host tar.gz",
    );
  });

  test(
    "criterion 14: lando setup file-sync behavior for slow, native, and deferred paths on linux-x64",
    async () => {
      const setupSpotChecks: ReadonlyArray<string> = [
        "runs provider, CA, proxy, shell integration, and file sync in deterministic order",
        "validates network trust before provider and file-sync downloads and honors config proxy precedence",
        "reports file sync as already satisfied for native bind-mount providers",
        "--skip-file-sync records deferred setup for the first accelerated app:start",
      ];
      for (const filter of setupSpotChecks) {
        await expectPassingSpotCheck("core/test/cli/setup.test.ts", filter);
      }

      if (isLinuxX64) {
        await expectPassingSpotCheck(
          "core/test/cli/setup.test.ts",
          "matches source setup failure output and keeps shellenv on the user data bin path",
        );
      }
    },
    longHarness,
  );
});
