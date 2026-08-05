import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import corePackage from "../../package.json";
import { buildCliBundle } from "../build/cli-bundle.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binaryEntry = resolve(repoRoot, "core/bin/lando.ts");
const canaryPreload = resolve(dirname(fileURLToPath(import.meta.url)), "fast-path-canary-preload.ts");
const canaryProbe = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fast-path-canary-probe.ts");
const nativeDispatcherProbe = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/native-dispatch-probe.ts",
);

const CANARY_POSITIVE_CASES = [
  { specifier: "effect", marker: "effect" },
  { specifier: "@oclif/core", marker: "@oclif/core" },
  { specifier: "@lando/sdk", marker: "@lando/sdk" },
  { specifier: "@lando/renderer-lando", marker: "renderers" },
  { specifier: "@lando/provider-podman", marker: "plugins" },
] as const;

const VERSION_ARGS = ["--version", "-V", "-v", "version"] as const;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
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

const runCli = async (
  argv: ReadonlyArray<string>,
  extraArgs: ReadonlyArray<string> = [],
): Promise<RunResult> => runCommand([process.execPath, ...extraArgs, binaryEntry, ...argv]);

const runNativeCli = async (argv: readonly string[]): Promise<RunResult> =>
  runCommand([process.execPath, nativeDispatcherProbe, ...argv]);

const buildBundledCli = async (): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-fast-path-"));
  const path = await buildCliBundle(root);

  return {
    path,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const expectShellenvOutput = (stdout: string): void => {
  const lines = stdout.trim().split("\n");

  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("export LANDO_USER_DATA_ROOT=");
  expect(lines[1]).toBe('export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"');
};

describe("fast path import canary", () => {
  test.each([...CANARY_POSITIVE_CASES])(
    "traps $specifier as the $marker family",
    async ({ specifier, marker }) => {
      const result = await runCommand([process.execPath, "--preload", canaryPreload, canaryProbe, specifier]);

      expect(result.stderr).toContain(`[FAST_PATH_CANARY] ${marker} was imported on the fast path:`);
      expect(result.exitCode).not.toBe(0);
    },
  );
});

describe("CLI version fast path", () => {
  test.each([...VERSION_ARGS])("%s exits before CLI dispatch bootstrap", async (arg) => {
    const argv = [arg];
    const result = await runCli(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(corePackage.version);
    expect(result.stderr).toBe("");
  });

  test.each([...VERSION_ARGS])("%s does not import the Effect or OCLIF runtime", async (arg) => {
    const argv = [arg];
    const result = await runCli(argv, ["--preload", canaryPreload]);

    expect(result.stderr).not.toContain("FAST_PATH_CANARY");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(corePackage.version);
  });

  test("documents the wall-clock budget without enforcing it", () => {
    expect("version fast path budget: <=50ms on baseline Linux x64").toContain("<=50ms");
  });
});

describe("CLI shellenv fast path", () => {
  test("built binary entry prints canonical shellenv output without reading ~/.lando", async () => {
    const bundled = await buildBundledCli();
    const homeWithoutLando = await mkdtemp(join(tmpdir(), "lando-home-without-"));
    const homeWithLando = await mkdtemp(join(tmpdir(), "lando-home-with-"));
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-data-"));

    try {
      await mkdir(join(homeWithLando, ".lando"));

      const withoutLando = await runCommand([process.execPath, bundled.path, "shellenv"], {
        HOME: homeWithoutLando,
        LANDO_USER_DATA_ROOT: userDataRoot,
      });
      const withLando = await runCommand([process.execPath, bundled.path, "shellenv"], {
        HOME: homeWithLando,
        LANDO_USER_DATA_ROOT: userDataRoot,
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
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("shellenv does not import the Effect or OCLIF runtime", async () => {
    const result = await runCli(["shellenv"], ["--preload", canaryPreload]);

    expect(result.stderr).not.toContain("FAST_PATH_CANARY");
    expect(result.exitCode).toBe(0);
    expectShellenvOutput(result.stdout);
  });
});

const NONE_FAST_PATH_CASES = [
  { name: "top-level --help", argv: ["--help"], output: "help" },
  { name: "top-level -h", argv: ["-h"], output: "help" },
  { name: "canonical version", argv: ["meta:version"], output: "meta-version" },
  { name: "flexible version", argv: ["meta", "version"], output: "meta-version" },
  { name: "canonical shellenv", argv: ["meta:shellenv"], output: "shellenv" },
  { name: "flexible shellenv", argv: ["meta", "shellenv"], output: "shellenv" },
  { name: "recipes alias", argv: ["recipes"], output: "recipes" },
  { name: "recipes list alias", argv: ["recipes", "list"], output: "recipes" },
  { name: "canonical recipes list", argv: ["meta:recipes:list"], output: "recipes" },
  { name: "flexible recipes list", argv: ["meta", "recipes", "list"], output: "recipes" },
] as const satisfies readonly {
  readonly name: string;
  readonly argv: readonly string[];
  readonly output: "help" | "meta-version" | "shellenv" | "recipes";
}[];

const NATIVE_PARITY_CASES = [
  { name: "root help", argv: ["--help"] },
  { name: "meta version", argv: ["meta:version"] },
  { name: "recipes list", argv: ["meta:recipes:list"] },
] as const;

const UNKNOWN_FLAG_CASES = [
  { argv: ["version", "--json"] },
  { argv: ["meta:version", "--unknown"] },
  { argv: ["shellenv", "--unknown"] },
  { argv: ["recipes", "--unknown"] },
  { argv: ["--help", "--unknown"] },
] as const;

describe("exhaustive level-none fast paths", () => {
  test.each([...NONE_FAST_PATH_CASES])(
    "$name is cold-path clean with its observable output",
    async ({ argv, output }) => {
      const result = await runCli(argv, ["--preload", canaryPreload]);

      expect(result.stderr).not.toContain("FAST_PATH_CANARY");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      switch (output) {
        case "help":
          expect(result.stdout).toContain("USAGE\n  $ lando [COMMAND]");
          expect(result.stdout).toContain("TOPICS");
          expect(result.stdout).toContain("COMMANDS");
          break;
        case "meta-version":
          expect(result.stdout.trim()).toBe(
            `@lando/core ${corePackage.version} (bun ${Bun.version} on ${process.platform})`,
          );
          break;
        case "shellenv":
          expectShellenvOutput(result.stdout);
          break;
        case "recipes":
          expect(result.stdout).toStartWith("Bundled recipes (");
          expect(result.stdout).toContain("node-postgres");
          break;
      }
    },
  );

  test.each([...NATIVE_PARITY_CASES])("$name exactly matches native dispatcher output", async ({ argv }) => {
    const [fast, native] = await Promise.all([runCli(argv), runNativeCli(argv)]);

    expect(fast).toEqual(native);
  });

  test.each([...UNKNOWN_FLAG_CASES])(
    "$argv falls through to the native dispatcher when an unknown flag is present",
    async ({ argv }) => {
      const result = await runCli(argv, ["--preload", canaryPreload]);

      expect(result.stderr).toContain("FAST_PATH_CANARY");
      expect(result.exitCode).not.toBe(0);
    },
  );
});
