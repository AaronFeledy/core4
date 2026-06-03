import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const coreRoot = resolve(import.meta.dirname, "../..");
const sourceCliPath = resolve(coreRoot, "bin/lando.ts");
const compiledBinaryPath = resolve(coreRoot, "dist/lando");
const bunBinDir = dirname(process.execPath);
const spawnPath = `${bunBinDir}:${process.env.PATH ?? ""}`;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: Array<string>,
  env: Readonly<Record<string, string>> = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd: coreRoot,
    env: { ...process.env, PATH: spawnPath, ...env },
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

const stripAnsi = (value: string): string => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") index += 1;
      continue;
    }
    output += value[index];
  }
  return output;
};

const normalizeRendererError = (stderr: string): string =>
  stripAnsi(stderr)
    .split("\n")
    .map((line) => line.trim().replace(/^.*Error: /u, ""))
    .filter(
      (line) =>
        line.includes("RendererSelectionError") ||
        line.includes("Unsupported renderer value") ||
        line.startsWith("value:") ||
        line.startsWith("source:") ||
        line.startsWith("Use --renderer=<value>"),
    )
    .join("\n");

let stateDir = "";
let confDir = "";

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "lando-renderer-flag-data-"));
  confDir = await mkdtemp(join(tmpdir(), "lando-renderer-flag-conf-"));
});

afterAll(async () => {
  if (stateDir.length > 0) await rm(stateDir, { recursive: true, force: true });
  if (confDir.length > 0) await rm(confDir, { recursive: true, force: true });
});

const isolationEnv = (): Record<string, string> => ({
  LANDO_USER_DATA_ROOT: stateDir,
  LANDO_USER_CONF_ROOT: confDir,
});

describe("--renderer flag (source CLI)", () => {
  test("accepts --renderer=json on apps:list without affecting output", async () => {
    const baseline = await runCommand([process.execPath, sourceCliPath, "apps:list"], isolationEnv());
    const withFlag = await runCommand(
      [process.execPath, sourceCliPath, "apps:list", "--renderer=json"],
      isolationEnv(),
    );
    expect(withFlag.exitCode).toBe(baseline.exitCode);
    expect(withFlag.stdout).toBe(baseline.stdout);
  }, 30_000);

  test("accepts --renderer plain (space-separated form)", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "apps:list", "--renderer", "plain"],
      isolationEnv(),
    );
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("rejects --renderer=tui with RendererSelectionError before command runs", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "apps:list", "--renderer=tui"],
      isolationEnv(),
    );
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).toContain("tui");
    expect(normalized).toContain("source: flag");
    expect(normalized).toContain("Use --renderer=<value>");
    expect(normalized).toContain("lando");
    expect(normalized).toContain("json");
    expect(normalized).toContain("plain");
  }, 30_000);

  test("rejects LANDO_RENDERER=tui env value with RendererSelectionError source=env", async () => {
    const result = await runCommand([process.execPath, sourceCliPath, "apps:list"], {
      ...isolationEnv(),
      LANDO_RENDERER: "tui",
    });
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).toContain("source: env");
    expect(normalized).toContain("tui");
  }, 30_000);

  test("flag wins over env (valid flag overrides invalid env)", async () => {
    const result = await runCommand([process.execPath, sourceCliPath, "apps:list", "--renderer=json"], {
      ...isolationEnv(),
      LANDO_RENDERER: "tui",
    });
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("rejects --renderer with no value supplied", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "apps:list", "--renderer"],
      isolationEnv(),
    );
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).toContain("requires a value");
  }, 30_000);

  test("rejects --renderer=tui even on a Beta-deferred command (validation happens first)", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "meta:plugin:new", "--renderer=tui"],
      isolationEnv(),
    );
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).not.toContain("NotImplementedError");
  }, 30_000);

  test("rejects --renderer=tui when --help is also present (parity with compiled path)", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "apps:list", "--renderer=tui", "--help"],
      isolationEnv(),
    );
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).toContain("source: flag");
    expect(normalized).toContain("tui");
  }, 30_000);

  test("rejects LANDO_RENDERER=tui when --help is also present", async () => {
    const result = await runCommand([process.execPath, sourceCliPath, "apps:list", "--help"], {
      ...isolationEnv(),
      LANDO_RENDERER: "tui",
    });
    expect(result.exitCode).not.toBe(0);
    const normalized = stripAnsi(result.stderr);
    expect(normalized).toContain("RendererSelectionError");
    expect(normalized).toContain("source: env");
  }, 30_000);
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "--renderer flag (compiled $bunfs CLI parity)",
  () => {
    test("matches source CLI rejection of --renderer=tui", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const env = isolationEnv();
      const source = await runCommand([process.execPath, sourceCliPath, "apps:list", "--renderer=tui"], env);
      const compiled = await runCommand([compiledBinaryPath, "apps:list", "--renderer=tui"], env);
      const sourceError = normalizeRendererError(source.stderr);
      const compiledError = normalizeRendererError(compiled.stderr);

      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiledError).toBe(sourceError);
      expect(compiledError.length).toBeGreaterThan(0);
    }, 180_000);

    test("compiled CLI accepts --renderer=json and runs the command normally", async () => {
      const env = isolationEnv();
      const baseline = await runCommand([compiledBinaryPath, "apps:list"], env);
      const withFlag = await runCommand([compiledBinaryPath, "apps:list", "--renderer=json"], env);
      expect(withFlag.exitCode).toBe(baseline.exitCode);
      expect(withFlag.stdout).toBe(baseline.stdout);
    }, 60_000);

    test("compiled CLI rejects LANDO_RENDERER=tui env value with RendererSelectionError source=env", async () => {
      const result = await runCommand([compiledBinaryPath, "apps:list"], {
        ...isolationEnv(),
        LANDO_RENDERER: "tui",
      });
      expect(result.exitCode).not.toBe(0);
      const normalized = stripAnsi(result.stderr);
      expect(normalized).toContain("RendererSelectionError");
      expect(normalized).toContain("source: env");
    }, 60_000);
  },
);
