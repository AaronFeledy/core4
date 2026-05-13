import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, cwd = repoRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
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

describe("biome lint gate", () => {
  test("root lint script passes on a clean tree and fails on a lint violation", async () => {
    const clean = await runCommand([process.execPath, "run", "lint"]);
    expect(clean.exitCode).toBe(0);

    const violationPath = resolve(repoRoot, "core/test/build/biome-lint-violation.tmp.ts");

    try {
      await writeFile(
        violationPath,
        `import { readFileSync } from "node:fs";

export const lintViolation = true;
`,
      );

      const violation = await runCommand([process.execPath, "run", "lint"]);
      expect(violation.exitCode).not.toBe(0);
      expect(`${violation.stdout}\n${violation.stderr}`).toContain("biome-lint-violation.tmp.ts");
    } finally {
      await rm(violationPath, { force: true });
    }
  });
});
