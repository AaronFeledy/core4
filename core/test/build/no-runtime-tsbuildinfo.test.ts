import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

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

describe("tsbuildinfo runtime isolation", () => {
  test("importing @lando/core does not open tsc build-info artifacts", async () => {
    const buildInfoPath = resolve(coreRoot, "dist/.tsbuildinfo");
    const tempRoot = await mkdtemp(resolve(tmpdir(), "lando-tsbuildinfo-"));
    const preloadPath = resolve(tempRoot, "guard.ts");
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
      await rm(buildInfoPath, { force: true });
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("clean removes dist and tsbuildinfo artifacts from every workspace", async () => {
    const artifacts = [
      "dist/.tsbuildinfo",
      ".tsbuildinfo",
      "core/dist/.tsbuildinfo",
      "core/.tsbuildinfo",
      "sdk/dist/.tsbuildinfo",
      "sdk/.tsbuildinfo",
      "plugins/service-lando/dist/.tsbuildinfo",
      "plugins/service-lando/.tsbuildinfo",
      "plugins/provider-docker/dist/.tsbuildinfo",
      "plugins/provider-docker/.tsbuildinfo",
      "plugins/proxy-traefik/dist/.tsbuildinfo",
      "plugins/proxy-traefik/.tsbuildinfo",
      "plugins/ca-mkcert/dist/.tsbuildinfo",
      "plugins/ca-mkcert/.tsbuildinfo",
      "plugins/logger-pretty/dist/.tsbuildinfo",
      "plugins/logger-pretty/.tsbuildinfo",
      "plugins/renderer-listr/dist/.tsbuildinfo",
      "plugins/renderer-listr/.tsbuildinfo",
    ].map((path) => resolve(repoRoot, path));

    await Promise.all(artifacts.map(writeArtifact));

    const clean = await runCommand([process.execPath, "run", "clean"]);
    expect(clean.exitCode).toBe(0);

    const remaining = await Promise.all(
      artifacts.map(async (path) => ({ path, exists: await Bun.file(path).exists() })),
    );
    expect(remaining.filter((artifact) => artifact.exists)).toEqual([]);
  });
});
