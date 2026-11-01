import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");

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

const writeArtifact = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "build info cache");
};

const workspacePackagePaths = async (): Promise<ReadonlyArray<string>> => {
  const rootPackage = await Bun.file(resolve(repoRoot, "package.json")).json();
  const paths: string[] = [];
  for (const workspace of rootPackage.workspaces.packages as string[]) {
    for await (const path of new Glob(`${workspace}/package.json`).scan({ cwd: repoRoot })) {
      paths.push(path);
    }
  }
  return paths.sort();
};

describe("tsbuildinfo runtime isolation", () => {
  test("importing @lando/core does not open tsc build-info artifacts", async () => {
    const buildInfoPath = resolve(coreRoot, "dist/.tsbuildinfo");
    const tempRoot = await mkdtemp(resolve(tmpdir(), "lando-tsbuildinfo-"));
    const preloadPath = resolve(tempRoot, "guard.ts");
    const existingBuildInfo = await readFile(buildInfoPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    await writeArtifact(buildInfoPath);

    await writeFile(
      preloadPath,
      `const fs = require("node:fs");
const opened = [];
const wrap = (name) => {
  const original = fs[name];
  fs[name] = (...args) => {
    const path = String(args[0]);
    if (path.endsWith(".tsbuildinfo")) opened.push(path);
    return original(...args);
  };
};
wrap("openSync");
wrap("readFileSync");
process.on("exit", () => {
  if (opened.length > 0) {
    console.error(JSON.stringify(opened));
    process.exitCode = 1;
  }
});
`,
    );

    try {
      const result = await runCommand([
        process.execPath,
        "--preload",
        preloadPath,
        "-e",
        "await import('@lando/core')",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      if (existingBuildInfo === undefined) await rm(buildInfoPath, { force: true });
      else await writeFile(buildInfoPath, existingBuildInfo);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("clean removes dist and tsbuildinfo artifacts from every workspace", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "lando-clean-workspace-"));
    try {
      const rootPackage = await Bun.file(resolve(repoRoot, "package.json")).json();
      await writeFile(
        resolve(fixtureRoot, "package.json"),
        JSON.stringify({
          name: rootPackage.name,
          private: true,
          workspaces: rootPackage.workspaces,
          scripts: { clean: rootPackage.scripts.clean },
        }),
      );

      const artifacts = [resolve(fixtureRoot, "dist/.tsbuildinfo"), resolve(fixtureRoot, ".tsbuildinfo")];
      const cleanlessWorkspaces = new Set([
        "docs/package.json",
        "plugins/secret-store-1password/package.json",
        "plugins/ssh-agent/package.json",
      ]);
      const packagePaths = await workspacePackagePaths();
      expect(packagePaths).toContain("core/package.json");
      expect(packagePaths).toContain("sdk/package.json");
      for (const packagePath of packagePaths) {
        const source = await Bun.file(resolve(repoRoot, packagePath)).json();
        const fixturePath = resolve(fixtureRoot, packagePath);
        await mkdir(dirname(fixturePath), { recursive: true });
        await writeFile(
          fixturePath,
          JSON.stringify({ name: source.name, scripts: { clean: source.scripts?.clean } }),
        );
        if (!cleanlessWorkspaces.has(packagePath)) {
          expect(typeof source.scripts?.clean).toBe("string");
          const workspaceRoot = dirname(fixturePath);
          artifacts.push(resolve(workspaceRoot, "dist/.tsbuildinfo"), resolve(workspaceRoot, ".tsbuildinfo"));
        }
      }
      await Promise.all(artifacts.map(writeArtifact));

      const clean = await runCommand([process.execPath, "run", "clean"], fixtureRoot);
      expect({ exitCode: clean.exitCode, stderr: clean.stderr }).toMatchObject({ exitCode: 0 });

      const remaining = await Promise.all(
        artifacts.map(async (path) => ({ path, exists: await Bun.file(path).exists() })),
      );
      expect(remaining.filter((artifact) => artifact.exists)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
