/**
 * CLI dispatch parity coverage.
 *
 * This file covers both the failed OCLIF-in-compiled-binary route and the
 * source/compiled parity contract.
 *
 * The probe (`parity/oclif-static-probe.ts`) is compiled to its own outfile and
 * run from outside the source tree so `Config.load()` -> `findRoot()` cannot
 * reach the repo `package.json`, matching the deployed `$bunfs` boundary. Its
 * observed failure shows that dispatching through `@oclif/core`'s `execute()` is
 * not reachable from a compiled single-file binary through any supported public
 * API.
 *
 * The parity cases compare source-mode OCLIF `execute()` with the compiled
 * hand-rolled `runCompiledCli` path and require semantically identical results
 * for the target commands.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureCompiledCli } from "../_support/compiled-cli.ts";
import { errorCodeFromStderr, normalizeJsonEnvelope, normalizeOutput } from "./parity/normalize.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const sourceCli = resolve(coreRoot, "bin/lando.ts");
let compiledBinary = "";
const probeSource = resolve(coreRoot, "test/cli/parity/oclif-static-probe.ts");

/** A command id that remains in the deferred-command registry. */
const DEFERRED_ID = "meta:plugin:login";

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runProcess = async (
  cmd: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
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

const runSource = (args: ReadonlyArray<string>, opts?: { cwd?: string; env?: Record<string, string> }) =>
  runProcess([process.execPath, sourceCli, ...args], opts);

const runCompiled = (args: ReadonlyArray<string>, opts?: { cwd?: string; env?: Record<string, string> }) =>
  runProcess([compiledBinary, ...args], opts);

const lastJsonLine = (output: string): unknown => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  const line = lines.at(-1);
  if (line === undefined) throw new Error(`no JSON envelope found in output: ${output.slice(0, 200)}`);
  return JSON.parse(line);
};

describe.skipIf(!isLinuxX64)("CLI dispatch unification spike", () => {
  beforeAll(async () => {
    compiledBinary = await ensureCompiledCli();
  }, 240_000);

  describe("Arm A — OCLIF execute() cannot dispatch inside a compiled binary", () => {
    let probeDir = "";
    let probeBinary = "";
    let probeRunDir = "";
    let probeResult: RunResult | undefined;

    beforeAll(async () => {
      probeDir = mkdtempSync(join(tmpdir(), "lando-oclif-probe-"));
      probeBinary = join(probeDir, "oclif-static-probe");
      probeRunDir = mkdtempSync(join(tmpdir(), "lando-oclif-probe-run-"));
      const build = await runProcess(
        [process.execPath, "build", probeSource, "--compile", "--outfile", probeBinary],
        { cwd: coreRoot },
      );
      expect(build.exitCode, `probe build failed: ${build.stderr}`).toBe(0);
      probeResult = await runProcess([probeBinary, "meta:version"], { cwd: probeRunDir });
    }, 240_000);

    afterAll(() => {
      if (probeDir) rmSync(probeDir, { recursive: true, force: true });
      if (probeRunDir) rmSync(probeRunDir, { recursive: true, force: true });
    });

    test("the probe fails to dispatch (non-zero exit)", () => {
      expect(probeResult?.exitCode, "OCLIF dispatch in $bunfs must not succeed").not.toBe(0);
    });

    test("the failure is OCLIF's filesystem-rooting boundary, not a probe bug", () => {
      const stderr = probeResult?.stderr ?? "";
      // findRoot cannot locate package.json next to the relocated binary.
      expect(stderr).toContain("could not find package.json");
      // The probe only prints PROBE_VERDICT on the (falsifiable) success path,
      // where execute() returns without throwing. It must NOT have dispatched.
      expect(stderr).not.toContain('"dispatched":true');
    });
  });

  describe("Arm B — source ↔ compiled dispatch parity", () => {
    test("S1 meta:bun --version passthrough: identical exit code and stdout", async () => {
      const source = await runSource(["meta:bun", "--version"]);
      const compiled = await runCompiled(["meta:bun", "--version"]);
      expect(compiled.exitCode).toBe(0);
      expect(source.exitCode).toBe(0);
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("S2 deferred id: identical exit code and byte-identical JSON envelope", async () => {
      const source = await runSource([DEFERRED_ID, "--renderer=json"]);
      const compiled = await runCompiled([DEFERRED_ID, "--renderer=json"]);
      expect(source.exitCode).toBe(1);
      expect(compiled.exitCode).toBe(source.exitCode);

      const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
      const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
      expect(compiledEnvelope).toEqual(sourceEnvelope);
      expect(sourceEnvelope.code).toBe("NotImplementedError");
      expect(sourceEnvelope.commandId).toBe(DEFERRED_ID);
    }, 30_000);

    test("S2 deferred id (plain): same tagged error code on both paths", async () => {
      const source = await runSource([DEFERRED_ID]);
      const compiled = await runCompiled([DEFERRED_ID]);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(errorCodeFromStderr(compiled.stderr)).toBe("NotImplementedError");
      expect(errorCodeFromStderr(source.stderr)).toBe("NotImplementedError");
    }, 30_000);

    test("S3 app:start with no Landofile: byte-identical JSON envelope", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lando-spike-nostart-"));
      try {
        const source = await runSource(["app:start", "--renderer=json"], { cwd });
        const compiled = await runCompiled(["app:start", "--renderer=json"], { cwd });
        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(source.exitCode);

        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope.code).toBe("LandofileNotFoundError");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);

    test("S4 meta:setup (host-safe): identical exit code and tagged error fields", async () => {
      // PATH=/no-such-path + temp roots + an explicit provider that fails fast at
      // capability detection => deterministic, hermetic (no network), no host mutation.
      const confRoot = mkdtempSync(join(tmpdir(), "lando-spike-conf-"));
      const dataRoot = mkdtempSync(join(tmpdir(), "lando-spike-data-"));
      const safeEnv = {
        PATH: "/no-such-path",
        HOME: process.env.HOME ?? tmpdir(),
        LANDO_USER_CONF_ROOT: confRoot,
        LANDO_USER_DATA_ROOT: dataRoot,
      };
      try {
        const source = await runSource(["meta:setup", "--provider=podman"], { cwd: tmpdir(), env: safeEnv });
        const compiled = await runCompiled(["meta:setup", "--provider=podman"], {
          cwd: tmpdir(),
          env: safeEnv,
        });
        expect(source.exitCode).not.toBe(0);
        expect(compiled.exitCode).toBe(source.exitCode);
        const code = errorCodeFromStderr(source.stderr);
        expect(code).toBe("ProviderUnavailableError");
        expect(errorCodeFromStderr(compiled.stderr)).toBe(code);
        expect(compiled.stderr).toContain("commandId: meta:setup");
        expect(source.stderr).toContain("commandId: meta:setup");
      } finally {
        rmSync(confRoot, { recursive: true, force: true });
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }, 30_000);

    test("S5 meta:doctor corrupt bootstrap: equivalent redacted JSON reports", async () => {
      // Given a malformed config containing a registered secret and an external run directory
      const home = mkdtempSync(join(tmpdir(), "lando-spike-doctor-home-"));
      const runRoot = mkdtempSync(join(tmpdir(), "lando-spike-doctor-run-"));
      const configRoot = join(home, ".config");
      const dataRoot = join(home, ".local", "share", "lando");
      const secret = "doctor-bootstrap-secret-9f3a";
      mkdirSync(join(configRoot, "lando"), { recursive: true });
      writeFileSync(join(configRoot, "lando", "config.yml"), `token: ${secret}\nbroken: [value\n`, "utf8");
      const env = {
        HOME: home,
        XDG_CONFIG_HOME: configRoot,
        LANDO_USER_DATA_ROOT: dataRoot,
        LANDO_TEST_TOKEN: secret,
        PATH: process.env.PATH ?? "/usr/bin",
      };

      try {
        // When
        const args = ["meta:doctor", "--renderer=json", "--format=json"];
        const source = await runSource(args, { cwd: runRoot, env });
        const compiled = await runCompiled(args, { cwd: runRoot, env });

        // Then
        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(1);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope).toMatchObject({
          apiVersion: "v4",
          command: "meta:doctor",
          ok: true,
          result: {
            provider: {},
            globalApp: {},
            subsystems: {},
            mcp: {},
          },
        });
        const normalized = JSON.stringify(sourceEnvelope);
        expect(normalized).toContain("provider-bootstrap");
        expect(normalized).toContain("ConfigError");
        expect(`${source.stdout}${source.stderr}${compiled.stdout}${compiled.stderr}`).not.toContain(secret);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(runRoot, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
