import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const command = join(repositoryRoot, "scripts/check-boundaries.ts");

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: readonly string[]): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, "run", command, ...args], {
    cwd: repositoryRoot,
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

describe("check-boundaries CLI", () => {
  test("lists all registered rule ids", async () => {
    // Given
    const expected = [
      "env-helper",
      "import-cycle",
      "libpod-prefix",
      "machine-output",
      "managed-file",
      "network",
      "package-dag",
      "paths",
      "probe",
      "redaction",
      "renderer",
      "spec-reference",
      "state-store",
      "generated-output",
    ];

    // When
    const result = await runCli(["--list"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: `${expected.join("\n")}\n`, stderr: "" });
  });

  test("runs all rules successfully against a clean fixture", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "boundary-cli-"));
    await Promise.all([
      mkdir(join(root, "core/src"), { recursive: true }),
      mkdir(join(root, "sdk/src"), { recursive: true }),
      mkdir(join(root, "plugins/example/src"), { recursive: true }),
    ]);

    try {
      // When
      const result = await runCli(["--all", `--root=${root}`]);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an unknown rule id with a usable message", async () => {
    // Given
    const unknownId = "not-a-boundary";

    // When
    const result = await runCli([unknownId]);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`Unknown boundary rule: ${unknownId}`);
    expect(result.stderr).toContain("--list");
  });
});
