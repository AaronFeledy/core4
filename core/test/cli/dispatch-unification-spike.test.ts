/**
 * CLI dispatch unification spike.
 *
 * Two arms:
 *
 *   Arm A (experiment) — attempts to get `@oclif/core`'s `execute()` to dispatch
 *   inside a `bun build --compile` single-file binary against the static command
 *   registry, the way the "unify on OCLIF" option would require. The probe
 *   (`parity/oclif-static-probe.ts`) is compiled to its own outfile and run from
 *   OUTSIDE the source tree so `Config.load()` → `findRoot()` cannot reach the
 *   repo `package.json` — a faithful deployed-`$bunfs` reproduction. Its observed
 *   failure is the evidence that the naive OCLIF-in-binary path is not reachable
 *   through any supported public API.
 *
 *   Arm B (parity) — proves the two SHIPPING dispatch paths (source-mode OCLIF
 *   `execute()` and the compiled hand-rolled `runCompiledCli`) produce
 *   semantically identical results for the four spike target commands. This is
 *   the divergence-surface contract that makes "accept dual dispatch as
 *   permanent" (option b) safe, and the harness a later story inherits.
 *
 * Conclusion is recorded in `spec/14-appendices.md` §D.1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { errorCodeFromStderr, normalizeJsonEnvelope, normalizeOutput } from "./parity/normalize.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const sourceCli = resolve(coreRoot, "bin/lando.ts");
const compiledBinary = resolve(coreRoot, "dist/lando");
const probeSource = resolve(coreRoot, "test/cli/parity/oclif-static-probe.ts");

/** A still-deferred Phase 4 RC canonical id (kept off `MVP_COMMAND_IDS`). */
const DEFERRED_ID = "meta:plugin:new";

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
    if (!(await Bun.file(compiledBinary).exists())) {
      const build = await runProcess([process.execPath, "run", "build:compile"], { cwd: coreRoot });
      expect(build.exitCode, `build:compile failed: ${build.stderr}`).toBe(0);
    }
  }, 240_000);

  describe("Arm A — OCLIF execute() cannot dispatch inside a compiled binary", () => {
    let probeDir = "";
    let probeBinary = "";
    let probeRunDir = "";
    let probeResult: RunResult | undefined;

    beforeAll(async () => {
      // Compile the probe to its OWN outfile OUTSIDE the repo, then run it from
      // a fresh dir OUTSIDE the repo so findRoot cannot reach the source tree.
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

  describe("Arm B — source ↔ compiled dispatch parity (option-b divergence contract)", () => {
    test("S1 meta:bun --version passthrough: identical exit code and stdout", async () => {
      const source = await runSource(["meta:bun", "--version"]);
      const compiled = await runCompiled(["meta:bun", "--version"]);
      expect(compiled.exitCode).toBe(0);
      expect(source.exitCode).toBe(0);
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    });

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
    });

    test("S2 deferred id (plain): same tagged error code on both paths", async () => {
      const source = await runSource([DEFERRED_ID]);
      const compiled = await runCompiled([DEFERRED_ID]);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(errorCodeFromStderr(compiled.stderr)).toBe("NotImplementedError");
      expect(errorCodeFromStderr(source.stderr)).toBe("NotImplementedError");
    });

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
    });

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
    });
  });
});
