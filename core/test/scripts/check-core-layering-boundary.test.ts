import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dirname, "../../..");

type GateResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCommand = async (args: readonly string[]): Promise<GateResult> => {
  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("boundary package script surface", () => {
  test("publishes one aggregate boundary package script", async () => {
    // Given: the root package script surface.
    const manifest = await Bun.file(join(repoRoot, "package.json")).text();

    // When / Then: the aggregate is public and the retired layering alias is absent.
    expect(manifest).toContain('"check:boundaries": "bun run scripts/check-boundaries.ts --all"');
    expect(manifest).not.toContain('"check:core-layering-boundary":');
  });

  test("runs package-dag through the canonical boundary runner", async () => {
    // Given / When: the stable rule id is invoked through the canonical runner.
    const result = await runCommand(["scripts/check-boundaries.ts", "package-dag"]);

    // Then: the package ownership gate still executes successfully.
    expect(result).toMatchObject({ exitCode: 0, stdout: "Package DAG check passed.\n" });
  });

  test("rejects a removed per-rule package alias", async () => {
    // Given / When: a deleted package alias is invoked.
    const result = await runCommand(["check:managed-file-boundary"]);

    // Then: Bun reports the package script as unknown.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Script not found "check:managed-file-boundary"');
  });
});
