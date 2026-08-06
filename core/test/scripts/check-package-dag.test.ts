import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let root: string;

type PackageEdges = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

const write = async (path: string, contents: string): Promise<void> => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
};

const writePackage = async (directory: string, name: string, edges: PackageEdges = {}): Promise<void> => {
  await write(`${directory}/package.json`, `${JSON.stringify({ name, ...edges })}\n`);
};

const writeRoot = async (workspaces: readonly string[]): Promise<void> => {
  await write("package.json", `${JSON.stringify({ private: true, workspaces })}\n`);
};

const runGate = async (
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
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
    writeRoot(["core", "sdk", "container-runtime", "paths", "state-store", "plugins/*"]),
    writePackage("core", "@lando/core", {
      dependencies: {
        "@lando/container-runtime": "workspace:*",
        "@lando/paths": "workspace:*",
        "@lando/sdk": "workspace:*",
        "@lando/state-store": "workspace:*",
      },
    }),
    writePackage("sdk", "@lando/sdk"),
    writePackage("container-runtime", "@lando/container-runtime", {
      dependencies: { "@lando/sdk": "workspace:*" },
    }),
    writePackage("paths", "@lando/paths", { dependencies: { "@lando/sdk": "workspace:*" } }),
    writePackage("state-store", "@lando/state-store", {
      dependencies: { "@lando/paths": "workspace:*", "@lando/sdk": "workspace:*" },
    }),
    writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/container-runtime": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    }),
    writePackage("plugins/provider-podman", "@lando/provider-podman", {
      dependencies: {
        "@lando/container-runtime": "workspace:*",
        "@lando/provider-lando": "workspace:*",
        "@lando/sdk": "workspace:*",
      },
    }),
    writePackage("plugins/service-lando", "@lando/service-lando", {
      devDependencies: { "@lando/core": "workspace:*" },
    }),
    writePackage("plugins/renderer-lando", "@lando/renderer-lando", {
      dependencies: { "@lando/sdk": "workspace:*" },
      devDependencies: { "@lando/paths": "workspace:*" },
    }),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("check-package-dag", () => {
  test("allows the declared runtime and dev/test workspace graph", async () => {
    // Given: the complete fixture graph written by beforeEach

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("loads every member from root package.json", async () => {
    // Given
    await Promise.all([
      writeRoot(["core", "sdk", "container-runtime", "paths", "state-store", "plugins/*", "extra"]),
      writePackage("extra", "@lando/extra"),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagPackageDeclarationMissing]");
    expect(result.stdout).toContain("@lando/extra");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects an undeclared workspace edge with tagged remediation", async () => {
    // Given
    await writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/provider-podman": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagUndeclaredEdge]");
    expect(result.stdout).toContain("@lando/provider-lando dependencies -> @lando/provider-podman");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects a plugin runtime edge to core with tagged remediation", async () => {
    // Given
    await writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/core": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stdout).toContain("@lando/provider-lando dependencies -> @lando/core");
    expect(result.stdout).toContain("Remediation:");
  });

  test("rejects a seam runtime edge to core with tagged remediation", async () => {
    // Given
    await Promise.all([
      writeRoot(["core", "sdk", "container-runtime", "paths", "state-store", "landofile", "plugins/*"]),
      writePackage("landofile", "@lando/landofile", {
        dependencies: { "@lando/core": "workspace:*" },
      }),
    ]);

    // When
    const result = await runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stdout).toContain("@lando/landofile dependencies -> @lando/core");
    expect(result.stdout).toContain("Remediation:");
  });

  test("default mode exits unsuccessfully with tagged remediation", async () => {
    // Given
    await writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/core": "workspace:*" },
    });

    // When
    const result = await runGate([]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[PackageDagForbiddenRuntimeEdge]");
    expect(result.stderr).toContain("Remediation:");
  });
});
