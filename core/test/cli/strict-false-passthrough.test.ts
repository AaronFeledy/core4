import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const runSourceCli = async (args: ReadonlyArray<string>) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
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

describe("strict:false catalog passthrough", () => {
  test("meta:bun forwards extra argv instead of rejecting it as unexpected", async () => {
    const result = await runSourceCli(["bun", "-e", "console.log('us583-bun-ok')"]);
    expect(result.stderr).not.toContain("Unexpected argument");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("us583-bun-ok");
  }, 30_000);
});
