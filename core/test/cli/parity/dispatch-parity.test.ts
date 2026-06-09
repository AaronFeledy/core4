/**
 * Compiled-binary dispatch parity test layer.
 *
 * The compiled-binary CLI dispatch unification decision resolved to
 * option (b): the spike proved `@oclif/core`'s `execute()`
 * cannot dispatch inside a `bun build --compile` single-file binary, so the two
 * dispatch paths — source-mode OCLIF `execute()` and the compiled hand-rolled
 * `runCompiledCli` — are permanent. The parity rules are therefore
 * normative, and THIS layer enforces them across every canonical command id in
 * the compiled registry (`MVP_COMMAND_IDS` plus the stage-7
 * deferred-command set).
 *
 * Two parts:
 *
 *   Part 1 — structural parity (no spawn; runs on every platform). The canonical
 *   command-id universe is `Object.keys(compiledCommands)`. Every id is
 *   classified as exactly one of MVP-implemented or deferred; every MVP id has a
 *   compiled-dispatch branch in `core/src/cli/run.ts`; every deferred id has a
 *   registered deferral plan and NO bespoke dispatch branch (it routes through
 *   the generic `notImplementedErrorForCommand` fallthrough). This is the
 *   exhaustive coverage of the AC's "every canonical command id".
 *
 *   Part 2 — behavioral parity (drives the compiled binary on linux-x64). The
 *   two shipping paths are semantically identical for representative MVP commands
 *   (including `meta:version` / `meta:shellenv`, whose canonical forms must
 *   dispatch — not emit `NotImplementedError`) and for the deferred set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFERRED_COMMAND_PLANS, deferredCommandPlan } from "../../../src/cli/deferred-commands.ts";
import { isCanonicalLandoCommandId, isMvpCommandId } from "../../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../../src/cli/oclif/compiled-commands.ts";
import { errorCodeFromStderr, normalizeJsonEnvelope, normalizeOutput } from "./normalize.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const coreRoot = resolve(repoRoot, "core");
const runSourcePath = resolve(coreRoot, "src/cli/run.ts");
const sourceCli = resolve(coreRoot, "bin/lando.ts");
const compiledBinary = resolve(coreRoot, "dist/lando");

const CANONICAL_IDS: ReadonlyArray<string> = Object.keys(compiledCommands).sort();
const MVP_IDS: ReadonlyArray<string> = CANONICAL_IDS.filter(isMvpCommandId);
const DEFERRED_IDS: ReadonlyArray<string> = [...DEFERRED_COMMAND_PLANS.keys()].sort();

const runSource = readFileSync(runSourcePath, "utf-8");

/**
 * A canonical id has a compiled-dispatch branch when `runCompiledCli` compares
 * `argv[0]` against it (the `argv[0] === "<id>"` switch).
 *
 * The match is anchored to the actual dispatch comparison rather than a bare
 * quoted literal: several canonical ids legitimately appear elsewhere in
 * `run.ts` (argv normalization, passthrough guards, deferred-error parsing), so
 * a loose substring check would still pass if a real dispatch branch were
 * deleted. Anchoring to `argv[0] === "<id>"` makes deleting the branch a
 * detectable regression.
 */
const hasCompiledDispatchBranch = (id: string): boolean => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`argv\\[0\\]\\s*===\\s*"${escaped}"`).test(runSource);
};

describe("compiled-binary dispatch parity — structural", () => {
  test("the canonical command-id universe is non-empty and fully canonical", () => {
    expect(CANONICAL_IDS.length).toBeGreaterThan(0);
    for (const id of CANONICAL_IDS) {
      expect(isCanonicalLandoCommandId(id), `${id} must be a canonical namespaced id`).toBe(true);
    }
  });

  test("every canonical id is classified as exactly one of MVP-implemented or deferred", () => {
    for (const id of CANONICAL_IDS) {
      const mvp = isMvpCommandId(id);
      const deferred = deferredCommandPlan(id) !== undefined;
      expect(
        mvp !== deferred,
        `${id} must be exactly one of MVP-implemented or deferred (mvp=${mvp}, deferred=${deferred})`,
      ).toBe(true);
    }
  });

  test("the MVP and deferred sets partition the registry (exhaustive, disjoint)", () => {
    const partition = new Set([...MVP_IDS, ...DEFERRED_IDS]);
    expect(partition.size, "MVP and deferred sets must be disjoint").toBe(
      MVP_IDS.length + DEFERRED_IDS.length,
    );
    expect([...partition].sort()).toEqual(CANONICAL_IDS);
  });

  test("every MVP canonical id has a compiled-dispatch branch in run.ts", () => {
    const missing = MVP_IDS.filter((id) => !hasCompiledDispatchBranch(id));
    expect(missing, "every MVP id must have an argv[0] dispatch branch in core/src/cli/run.ts").toEqual([]);
  });

  test("every deferred canonical id has a registered plan and no bespoke dispatch branch", () => {
    for (const id of DEFERRED_IDS) {
      expect(deferredCommandPlan(id), `${id} must have a registered deferral plan`).toBeDefined();
      expect(
        hasCompiledDispatchBranch(id),
        `${id} must route through the generic NotImplementedError fallthrough, not a bespoke branch`,
      ).toBe(false);
    }
  });
});

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

const runSourceCli = (args: ReadonlyArray<string>, opts?: { cwd?: string; env?: Record<string, string> }) =>
  runProcess([process.execPath, sourceCli, ...args], opts);

const runCompiledCli = (args: ReadonlyArray<string>, opts?: { cwd?: string; env?: Record<string, string> }) =>
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

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!isLinuxX64)("compiled-binary dispatch parity — behavioral", () => {
  beforeAll(async () => {
    const build = await runProcess([process.execPath, "run", "build:compile"], { cwd: coreRoot });
    expect(build.exitCode, `build:compile failed: ${build.stderr}`).toBe(0);
  }, 240_000);

  describe("MVP canonical ids dispatch (not NotImplementedError) at parity", () => {
    test("meta:version: both paths exit 0 with the same version line", async () => {
      const source = await runSourceCli(["meta:version"]);
      const compiled = await runCompiledCli(["meta:version"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("meta:shellenv: both paths exit 0 with the same shell snippet", async () => {
      const source = await runSourceCli(["meta:shellenv"]);
      const compiled = await runCompiledCli(["meta:shellenv"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      // Install dir differs (source checkout vs compiled binary location); the
      // shared normalizer neutralizes the absolute path so the snippet shape
      // is compared for equality.
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("meta:shellenv invalid --shell fails on both paths", async () => {
      const source = await runSourceCli(["meta:shellenv", "--shell=fish"]);
      const compiled = await runCompiledCli(["meta:shellenv", "--shell=fish"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Expected --shell=fish to be one of: posix, powershell, pwsh");
    }, 30_000);

    test("meta:shellenv missing --shell value fails on both paths", async () => {
      const source = await runSourceCli(["meta:shellenv", "--shell"]);
      const compiled = await runCompiledCli(["meta:shellenv", "--shell"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Flag --shell expects one of these values: posix, powershell, pwsh");
    }, 30_000);

    test("app:start with no Landofile: both fail with LandofileNotFoundError, not NotImplementedError", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lando-parity-nostart-"));
      try {
        const source = await runSourceCli(["app:start", "--renderer=json"], { cwd });
        const compiled = await runCompiledCli(["app:start", "--renderer=json"], { cwd });
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
  });

  describe("deferred canonical ids defer identically on both paths", () => {
    const probeIds = ["meta:recipes:list", "meta:events:follow", "meta:uninstall"] as const;
    for (const id of probeIds) {
      test(`${id}: both paths emit NotImplementedError with matching tagged fields`, async () => {
        const source = await runSourceCli([id, "--renderer=json"]);
        const compiled = await runCompiledCli([id, "--renderer=json"]);
        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope.code).toBe("NotImplementedError");
        expect(sourceEnvelope.commandId).toBe(id);
      }, 30_000);
    }

    test("plain renderer: a deferred id reports the same tagged error code on both paths", async () => {
      const source = await runSourceCli(["meta:recipes:list"]);
      const compiled = await runCompiledCli(["meta:recipes:list"]);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(errorCodeFromStderr(source.stderr)).toBe("NotImplementedError");
      expect(errorCodeFromStderr(compiled.stderr)).toBe("NotImplementedError");
    }, 30_000);
  });
});

afterAll(() => {
  /* no-op: the shared compiled binary is reused, never removed here. */
});
