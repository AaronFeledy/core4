import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { importCycleRule } from "../../../scripts/boundary/rules/import-cycle.ts";
import { packageDagRule } from "../../../scripts/boundary/rules/package-dag.ts";

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
  test("declares the private seam packages a plugin may always import", () => {
    // Given / When
    const allowedPackages: readonly string[] = packageDagRule.alwaysAllowedPackages;

    // Then
    expect(allowedPackages).toEqual([
      "@lando/sdk",
      "@lando/container-runtime",
      "@lando/paths",
      "@lando/state-store",
    ]);
  });

  test("allows plugin edges into the private seam packages", async () => {
    // Given
    await write(
      "plugins/alpha/src/index.ts",
      [
        'import "@lando/sdk";',
        'import type { AbsolutePath } from "@lando/sdk/schema";',
        'import "@lando/paths";',
        'import "@lando/state-store";',
        'import "@lando/state-store/service";',
      ].join("\n"),
    );

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe("Package DAG violations: 0\n");
  });

  test("still reports core edges when seam edges share the file", async () => {
    // Given
    await write(
      "plugins/alpha/src/index.ts",
      [
        'import "@lando/state-store/service";',
        'import "@lando/core";',
        'import "@lando/paths";',
        'import type { Scratch } from "@lando/core/scratch";',
      ].join("\n"),
    );

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "plugins/alpha/src/index.ts:2: @lando/core",
        "plugins/alpha/src/index.ts:4: @lando/core/scratch",
        "Package DAG violations: 2",
        "",
      ].join("\n"),
    );
  });

  test("reports separator-escaped specifiers that resolve back into core", async () => {
    // Given: specifiers that name a seam package but walk out of it into core
    await write(
      "plugins/alpha/src/index.ts",
      [
        'import "@lando/state-store\\\\..\\\\core";',
        'import "@lando/sdk\\\\..\\\\core";',
        'import "@lando/core\\\\scratch";',
      ].join("\n"),
    );
    await write("state-store/src/index.ts", 'import "@lando/sdk\\\\..\\\\..\\\\plugins\\\\alpha\\\\src";\n');

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "plugins/alpha/src/index.ts:1: @lando/state-store\\..\\core",
        "plugins/alpha/src/index.ts:2: @lando/sdk\\..\\core",
        "plugins/alpha/src/index.ts:3: @lando/core\\scratch",
        "state-store/src/index.ts:1: @lando/sdk\\..\\..\\plugins\\alpha\\src",
        "Package DAG violations: 4",
        "",
      ].join("\n"),
    );
  });

  test("allows relative parent imports inside a plugin package", async () => {
    // Given
    await write("plugins/alpha/src/nested/index.ts", 'import "../shared/util.ts";\n');

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe("Package DAG violations: 0\n");
  });

  test("scans every TypeScript module extension for core edges", async () => {
    // Given
    await Promise.all([
      write("plugins/alpha/src/index.cts", 'import "@lando/core";\n'),
      write("plugins/alpha/src/index.mts", 'import "@lando/core";\n'),
      write("plugins/alpha/src/index.tsx", 'import "@lando/core";\n'),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "plugins/alpha/src/index.cts:1: @lando/core",
        "plugins/alpha/src/index.mts:1: @lando/core",
        "plugins/alpha/src/index.tsx:1: @lando/core",
        "Package DAG violations: 3",
        "",
      ].join("\n"),
    );
  });

  test("sees the same module extensions as the sibling import-graph rule", () => {
    // Given / When
    const extensions: readonly string[] = packageDagRule.scope.extensions;

    // Then
    expect(extensions).toEqual(importCycleRule.scope.extensions);
  });

  test("reports plugin-package edges from every non-plugin package source root", async () => {
    // Given
    await Promise.all([
      write("container-runtime/src/index.ts", 'import "@lando/beta";\n'),
      write("core/src/index.ts", 'import "@lando/beta";\n'),
      write("paths/src/index.ts", 'import "@lando/beta";\n'),
      write("sdk/src/index.ts", 'import "@lando/alpha/subpath";\n'),
      write("state-store/src/service.ts", 'import "@lando/alpha";\n'),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toBe(
      [
        "container-runtime/src/index.ts:1: @lando/beta",
        "core/src/index.ts:1: @lando/beta",
        "paths/src/index.ts:1: @lando/beta",
        "sdk/src/index.ts:1: @lando/alpha/subpath",
        "state-store/src/service.ts:1: @lando/alpha",
        "Package DAG violations: 5",
        "",
      ].join("\n"),
    );
  });

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
