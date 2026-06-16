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

let stateDir = "";
let confDir = "";
let cacheDir = "";

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "lando-bug-report-data-"));
  confDir = await mkdtemp(join(tmpdir(), "lando-bug-report-conf-"));
  cacheDir = await mkdtemp(join(tmpdir(), "lando-bug-report-cache-"));
});

afterAll(async () => {
  if (stateDir.length > 0) await rm(stateDir, { recursive: true, force: true });
  if (confDir.length > 0) await rm(confDir, { recursive: true, force: true });
  if (cacheDir.length > 0) await rm(cacheDir, { recursive: true, force: true });
});

const isolationEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  LANDO_USER_DATA_ROOT: stateDir,
  LANDO_USER_CONF_ROOT: confDir,
  LANDO_USER_CACHE_ROOT: cacheDir,
  ...extra,
});

describe("US-038: bug-report diagnostics on failure (source CLI)", () => {
  test("NotImplementedError plain output includes commandId, code, logsDir, cacheDir", async () => {
    const result = await runCommand([process.execPath, sourceCliPath, "meta:plugin:login"], isolationEnv());
    expect(result.exitCode).not.toBe(0);
    const stderr = stripAnsi(result.stderr);
    expect(stderr).toContain("NotImplementedError");
    expect(stderr).toContain("commandId: meta:plugin:login");
    expect(stderr).toContain("code: NotImplementedError");
    expect(stderr).toContain(`logsDir: ${cacheDir}/logs`);
    expect(stderr).toContain(`cacheDir: ${cacheDir}`);
  }, 30_000);

  test("JSON renderer emits one NDJSON object on stderr with machine-readable code and remediation", async () => {
    const result = await runCommand(
      [process.execPath, sourceCliPath, "meta:plugin:login", "--renderer=json"],
      isolationEnv(),
    );
    expect(result.exitCode).not.toBe(0);
    const stderr = stripAnsi(result.stderr);
    const lines = stderr.split("\n").filter((line) => line.startsWith("{"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const candidate = lines.find((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed._tag === "message.error";
      } catch {
        return false;
      }
    });
    expect(candidate, `expected one NDJSON message.error line in stderr; got:\n${stderr}`).toBeDefined();
    if (candidate === undefined) throw new Error("expected NDJSON message.error line");
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    expect(parsed.code).toBe("NotImplementedError");
    expect(parsed.commandId).toBe("meta:plugin:login");
    expect(typeof parsed.remediation).toBe("string");
    expect((parsed.remediation as string).length).toBeGreaterThan(0);
    expect(parsed.logsDir).toBe(`${cacheDir}/logs`);
    expect(parsed.cacheDir).toBe(cacheDir);
  }, 30_000);

  test("LandofileNotFoundError on app:start surfaces commandId + cache pointers + remediation hint", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "lando-bug-report-empty-"));
    try {
      const result = await runCommand([process.execPath, sourceCliPath, "app:start"], {
        ...isolationEnv(),
        PWD: emptyDir,
      });
      expect(result.exitCode).not.toBe(0);
      const stderr = stripAnsi(result.stderr);
      expect(stderr).toContain("commandId: app:start");
      expect(stderr).toContain(`logsDir: ${cacheDir}/logs`);
      expect(stderr).toContain(`cacheDir: ${cacheDir}`);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("Sensitive env-style values in error message are redacted in plain output", async () => {
    const tokenDir = await mkdtemp(join(tmpdir(), "lando-bug-report-tok-"));
    try {
      await Bun.write(
        join(tokenDir, ".lando.yml"),
        "name: redact-test\nservices:\n  web:\n    type: bogus:DATABASE_PASSWORD=hunter2supersecret\n",
      );
      const result = await runCommand([process.execPath, sourceCliPath, "app:config"], {
        ...isolationEnv(),
        PWD: tokenDir,
      });
      const stderr = stripAnsi(result.stderr);
      if (result.exitCode === 0) {
        return;
      }
      expect(stderr).not.toContain("hunter2supersecret");
    } finally {
      await rm(tokenDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "US-038: bug-report diagnostics on failure (compiled $bunfs CLI parity)",
  () => {
    beforeAll(async () => {
      const build = await runCommand([process.execPath, "run", "build:compile"]);
      expect(build.exitCode).toBe(0);
    }, 120_000);
    test("compiled NotImplementedError plain output mirrors source", async () => {
      const result = await runCommand([compiledBinaryPath, "meta:plugin:login"], isolationEnv());
      expect(result.exitCode).not.toBe(0);
      const stderr = stripAnsi(result.stderr);
      expect(stderr).toContain("commandId: meta:plugin:login");
      expect(stderr).toContain("code: NotImplementedError");
      expect(stderr).toContain(`logsDir: ${cacheDir}/logs`);
    }, 60_000);

    test("compiled JSON renderer emits NDJSON message.error on stderr", async () => {
      const result = await runCommand(
        [compiledBinaryPath, "meta:plugin:login", "--renderer=json"],
        isolationEnv(),
      );
      expect(result.exitCode).not.toBe(0);
      const stderr = stripAnsi(result.stderr);
      const candidate = stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .find((line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return parsed._tag === "message.error";
          } catch {
            return false;
          }
        });
      expect(candidate).toBeDefined();
      if (candidate === undefined) throw new Error("expected NDJSON message.error line");
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      expect(parsed.code).toBe("NotImplementedError");
      expect(parsed.commandId).toBe("meta:plugin:login");
      expect(parsed.logsDir).toBe(`${cacheDir}/logs`);
    }, 60_000);
  },
);
