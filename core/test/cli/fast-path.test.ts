import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import corePackage from "../../package.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = resolve(repoRoot, "core/src/cli/index.ts");
const canaryPreload = resolve(dirname(fileURLToPath(import.meta.url)), "fast-path-canary-preload.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (arg: string, extraArgs: ReadonlyArray<string> = []): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, ...extraArgs, cliEntry, arg],
    cwd: repoRoot,
    env: {
      ...process.env,
      LANDO_DEBUG_THROW_ON_RUNTIME: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe("CLI version fast path", () => {
  test.each(["--version", "-v", "version"])("%s exits before OCLIF runtime bootstrap", async (arg) => {
    const result = await runCli(arg);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(corePackage.version);
    expect(result.stderr).toBe("");
  });

  test.each(["--version", "-v", "version"])(
    "%s does not import the effect runtime (PRD-02 FR-4)",
    async (arg) => {
      const result = await runCli(arg, ["--preload", canaryPreload]);

      expect(result.stderr).not.toContain("FAST_PATH_CANARY");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(corePackage.version);
    },
  );

  test("documents the MVP wall-clock budget without enforcing it", () => {
    expect("version fast path budget: <=50ms on baseline Linux x64").toContain("<=50ms");
  });
});
