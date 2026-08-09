import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dirname, "../../..");

type GateResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runAlias = async (): Promise<GateResult> => {
  const child = Bun.spawn([process.execPath, "run", "check:core-layering-boundary"], {
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

describe("retired core-layering boundary alias", () => {
  test("maps the stable script name to package-dag", async () => {
    // Given / When
    const manifest = await Bun.file(join(repoRoot, "package.json")).text();

    // Then
    expect(manifest).toContain('"check:core-layering-boundary": "bun run check:package-dag"');
  });

  test("runs the package-dag gate through the stable script name", async () => {
    // Given / When
    const result = await runAlias();

    // Then
    expect(result).toMatchObject({ exitCode: 0, stdout: "Package DAG check passed.\n" });
    expect(result.stderr).toContain("$ bun run check:package-dag");
    expect(result.stderr).not.toContain("check-core-layering-boundary.ts");
  });
});
