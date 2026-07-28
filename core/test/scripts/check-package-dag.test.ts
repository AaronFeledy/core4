import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let root: string;

const write = async (path: string, contents: string): Promise<void> => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
};

const writePlugin = async (
  directory: string,
  name: string,
  dependencies: Readonly<Record<string, string>> = {},
): Promise<void> => {
  await write(`plugins/${directory}/package.json`, `${JSON.stringify({ name, dependencies })}\n`);
};

const runGate = async (
  args: ReadonlyArray<string>,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> => {
  const repositoryRoot = join(import.meta.dirname, "../../..");
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/check-package-dag.ts", ...args, "--root", root],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "package-dag-"));
  await Promise.all([
    write("core/package.json", '{"name":"@lando/core"}\n'),
    write("sdk/package.json", '{"name":"@lando/sdk"}\n'),
    write("container-runtime/package.json", '{"name":"@lando/container-runtime"}\n'),
    writePlugin("alpha", "@lando/alpha"),
    writePlugin("beta", "@lando/beta"),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("check-package-dag", () => {
  test("reports value and type-only core edges from plugin production source", async () => {
    // Given
    await write(
      "plugins/alpha/src/index.ts",
      ['import { runtime } from "@lando/core";', 'import type { Scratch } from "@lando/core/scratch";'].join(
        "\n",
      ),
    );

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "plugins/alpha/src/index.ts:1: @lando/core",
        "plugins/alpha/src/index.ts:2: @lando/core/scratch",
        "Package DAG violations: 2",
        "",
      ].join("\n"),
    );
  });

  test("allows a declared cross-plugin dependency", async () => {
    // Given
    await Promise.all([
      writePlugin("alpha", "@lando/alpha", { "@lando/beta": "workspace:*" }),
      write("plugins/alpha/src/index.ts", 'export { beta } from "@lando/beta";\n'),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe("Package DAG violations: 0\n");
  });

  test("reports an undeclared cross-plugin dependency", async () => {
    // Given
    await write("plugins/alpha/src/index.ts", 'void import("@lando/beta/subpath");\n');

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      "plugins/alpha/src/index.ts:1: @lando/beta/subpath\nPackage DAG violations: 1\n",
    );
  });

  test("reports declared cross-plugin edges that form a package cycle", async () => {
    // Given
    await Promise.all([
      writePlugin("alpha", "@lando/alpha", { "@lando/beta": "workspace:*" }),
      writePlugin("beta", "@lando/beta", { "@lando/alpha": "workspace:*" }),
      write("plugins/alpha/src/index.ts", 'import "@lando/beta";\n'),
      write("plugins/beta/src/index.ts", 'import "@lando/alpha";\n'),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "plugins/alpha/src/index.ts:1: @lando/beta",
        "plugins/beta/src/index.ts:1: @lando/alpha",
        "Package DAG violations: 2",
        "",
      ].join("\n"),
    );
  });

  test("allows only generated plugin-package edges from core production source", async () => {
    // Given
    await Promise.all([
      writePlugin("provider-docker", "@lando/provider-docker"),
      write("core/src/providers/x.ts", 'import "@lando/provider-docker";\n'),
      write("core/src/plugins/generated/bundled.ts", 'export { provider } from "@lando/provider-docker";\n'),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      "core/src/providers/x.ts:1: @lando/provider-docker\nPackage DAG violations: 1\n",
    );
  });

  test("ignores package-like string literals that are not module edges", async () => {
    // Given
    await write("plugins/alpha/src/index.ts", 'export const example = "@lando/core/scratch";\n');

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe("Package DAG violations: 0\n");
  });

  test("report mode prints violations and exits successfully", async () => {
    // Given
    await write("plugins/alpha/src/index.ts", 'import "@lando/core/scratch";\n');

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "plugins/alpha/src/index.ts:1: @lando/core/scratch\nPackage DAG violations: 1\n",
    );
    expect(result.stderr).toBe("");
  });

  test("default mode exits unsuccessfully when violations exist", async () => {
    // Given
    await write("plugins/alpha/src/index.ts", 'import "@lando/core";\n');

    // When
    const result = await runGate([]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plugins/alpha/src/index.ts:1: @lando/core");
  });

  test("accepts the equals form of the root argument", async () => {
    // Given
    const repositoryRoot = join(import.meta.dirname, "../../..");
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/check-package-dag.ts", "--report", `--root=${root}`],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );

    // When
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    // Then
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "Package DAG violations: 0\n",
      stderr: "",
    });
  });
});
