import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repoRoot, "scripts/check-architecture.ts");

const runCli = async (...args: ReadonlyArray<string>) => {
  const process = Bun.spawn([Bun.env.BUN_EXEC_PATH ?? "bun", cliPath, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("check-architecture CLI", () => {
  it("lists valid rule ids when a requested rule is unknown", async () => {
    // Given / When
    const result = await runCli("--rule=unknown-rule");

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown architecture rule: unknown-rule");
    expect(result.stderr).toContain("renderer-boundary");
    expect(result.stderr).toContain("import-cycle");
  });

  it("passes a selected rule on the clean repository tree", async () => {
    // Given / When
    const result = await runCli("--rule=renderer-boundary", `--root=${repoRoot}`);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Architecture check passed");
    expect(result.stdout).toContain("1 rules");
  });

  it("does not audit exceptions for rules outside --rule selection", async () => {
    // Given / When — managed-file/package-dag owner exceptions must not go stale-unused
    const result = await runCli("--rule=renderer-boundary", `--root=${repoRoot}`);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("managed-file");
    expect(result.stderr).not.toContain("package-dag");
  });
});
