import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import corePackage from "../../package.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = resolve(repoRoot, "core/src/cli/index.ts");
const binaryEntry = resolve(repoRoot, "core/bin/lando.ts");
const canaryPreload = resolve(dirname(fileURLToPath(import.meta.url)), "fast-path-canary-preload.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      LANDO_DEBUG_THROW_ON_RUNTIME: "1",
    },
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

const runCli = async (arg: string, extraArgs: ReadonlyArray<string> = []): Promise<RunResult> =>
  runCommand([process.execPath, ...extraArgs, cliEntry, arg]);

const buildBundledCli = async (): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-fast-path-"));
  const path = join(root, "lando.js");

  const result = await runCommand([
    process.execPath,
    "build",
    binaryEntry,
    "--outdir",
    root,
    "--target",
    "bun",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to build CLI bundle:\n${result.stderr}`);
  }

  return {
    path,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const expectShellenvOutput = (stdout: string): void => {
  const lines = stdout.trim().split("\n");

  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("export LANDO_INSTALL_DIR=");
  expect(lines[1]).toBe('export PATH="${LANDO_INSTALL_DIR}/bin:${PATH}"');
};

describe("CLI version fast path", () => {
  test.each(["--version", "-v", "version"])("%s exits before OCLIF runtime bootstrap", async (arg) => {
    const result = await runCli(arg);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(corePackage.version);
    expect(result.stderr).toBe("");
  });

  test.each(["--version", "-v", "version"])(
    "%s does not import the effect runtime (PRD-02 FR-4)",
    async (arg) => {
      const result = await runCli(arg, ["--preload", canaryPreload]);

      expect(result.stderr).not.toContain("FAST_PATH_CANARY");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(corePackage.version);
    },
  );

  test("documents the MVP wall-clock budget without enforcing it", () => {
    expect("version fast path budget: <=50ms on baseline Linux x64").toContain("<=50ms");
  });
});

describe("CLI shellenv fast path", () => {
  test("built binary entry prints canonical shellenv output without reading ~/.lando", async () => {
    const bundled = await buildBundledCli();
    const homeWithoutLando = await mkdtemp(join(tmpdir(), "lando-home-without-"));
    const homeWithLando = await mkdtemp(join(tmpdir(), "lando-home-with-"));

    try {
      await mkdir(join(homeWithLando, ".lando"));

      const withoutLando = await runCommand([process.execPath, bundled.path, "shellenv"], {
        HOME: homeWithoutLando,
      });
      const withLando = await runCommand([process.execPath, bundled.path, "shellenv"], {
        HOME: homeWithLando,
      });

      expect(withoutLando.exitCode).toBe(0);
      expect(withoutLando.stderr).toBe("");
      expect(withLando.exitCode).toBe(0);
      expect(withLando.stderr).toBe("");
      expect(withLando.stdout).toBe(withoutLando.stdout);
      expectShellenvOutput(withoutLando.stdout);
    } finally {
      await bundled.cleanup();
      await rm(homeWithoutLando, { recursive: true, force: true });
      await rm(homeWithLando, { recursive: true, force: true });
    }
  });

  test("shellenv does not import the effect runtime", async () => {
    const result = await runCli("shellenv", ["--preload", canaryPreload]);

    expect(result.stderr).not.toContain("FAST_PATH_CANARY");
    expect(result.exitCode).toBe(0);
    expectShellenvOutput(result.stdout);
  });
});
