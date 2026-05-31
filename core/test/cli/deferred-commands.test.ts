import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll } from "bun:test";
import {
  DEFERRED_COMMAND_PLANS,
  deferredCommandPlan,
  notImplementedErrorForCommand,
} from "../../src/cli/deferred-commands.ts";
import { isMvpCommandId } from "../../src/cli/oclif/command-base.ts";

import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";

interface FixtureEntry {
  readonly id: string;
  readonly phase: "Phase 3 Beta" | "Phase 4 RC";
  readonly specSection: string;
}

interface FixtureFile {
  readonly commands: ReadonlyArray<FixtureEntry>;
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const compiledBinary = resolve(coreRoot, "dist/lando");
const fixturePath = resolve(import.meta.dirname, "fixtures/deferred-commands.json");

const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, "utf-8")) as FixtureFile;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runProcess = async (
  cmd: ReadonlyArray<string>,
  env?: Record<string, string>,
  cwd = repoRoot,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env: { ...process.env, ...(env ?? {}) },
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

const runSource = async (commandId: string): Promise<RunResult> =>
  runProcess([process.execPath, cliEntry, commandId]);

const runCompiled = async (commandId: string): Promise<RunResult> => runProcess([compiledBinary, commandId]);

const SOURCE_FILE_PATH_PATTERN = /\/[A-Za-z0-9_.\-/]+\.(?:ts|js|tsx|jsx|mjs|cjs)(?:[:?]|\b)/;
const STACK_FRAME_PATTERN = /^\s*at\s+\S+/m;
const OCLIF_WARNING_PREFIX = "›";

const extractErrorBlock = (stderr: string): string => {
  const lines = stderr.split("\n");
  const cleaned: Array<string> = [];
  let seenError = false;
  for (const line of lines) {
    if (line.includes(OCLIF_WARNING_PREFIX)) continue;
    if (!seenError) {
      if (line.includes("NotImplementedError")) {
        seenError = true;
        cleaned.push(line.replace(/^\s*Error:\s*/, ""));
      }
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n");
};

const expectNoStackOrSourcePaths = (errorBlock: string, commandId: string): void => {
  expect(errorBlock, `${commandId}: error block must not contain a stack frame`).not.toMatch(
    STACK_FRAME_PATTERN,
  );
  expect(errorBlock, `${commandId}: error block must not embed source file paths`).not.toMatch(
    SOURCE_FILE_PATH_PATTERN,
  );
};

const expectPhaseTaggedRemediation = (stderr: string, entry: FixtureEntry): void => {
  expect(stderr, `${entry.id}: stderr must contain the NotImplementedError tag`).toContain(
    "NotImplementedError",
  );
  expect(stderr, `${entry.id}: stderr must echo the commandId`).toContain(`commandId: ${entry.id}`);
  expect(stderr, `${entry.id}: stderr must echo the specSection`).toContain(
    `specSection: ${entry.specSection}`,
  );
  expect(stderr, `${entry.id}: stderr must name the target phase`).toContain(entry.phase);
  expect(stderr, `${entry.id}: stderr must point at the roadmap`).toContain("spec/ROADMAP.md");

  const errorBlock = extractErrorBlock(stderr);
  expect(errorBlock.length, `${entry.id}: error block must be non-empty`).toBeGreaterThan(0);
  expectNoStackOrSourcePaths(errorBlock, entry.id);
};

describe("deferred command remediation contract (US-037)", () => {
  test("fixture covers every command surface in the AC list", () => {
    const ids = new Set(fixture.commands.map((entry) => entry.id));
    const requiredPrefixes = ["apps:scratch:", "meta:global:", "app:includes:"];
    const requiredExactIds = [
      "app:config:translate",
      "meta:plugin:new",
      "meta:plugin:test",
      "meta:plugin:build",
      "meta:plugin:link",
      "meta:plugin:unlink",
      "meta:plugin:publish",
      "meta:plugin:trust",
      "meta:plugin:trust-authoring-root",
    ];
    for (const prefix of requiredPrefixes) {
      const matches = [...ids].filter((id) => id.startsWith(prefix));
      expect(matches.length, `AC requires at least one fixture entry for ${prefix}*`).toBeGreaterThan(0);
    }
    for (const id of requiredExactIds) {
      expect(ids.has(id), `AC requires fixture entry for ${id}`).toBe(true);
    }
  });

  test("DEFERRED_COMMAND_PLANS covers every fixture entry with matching phase/specSection", () => {
    for (const entry of fixture.commands) {
      const plan = deferredCommandPlan(entry.id);
      expect(plan, `${entry.id} must have a registered deferral plan`).toBeDefined();
      if (plan === undefined) continue;
      expect(plan.phase, `${entry.id}: phase mismatch`).toBe(entry.phase);
      expect(plan.specSection, `${entry.id}: specSection mismatch`).toBe(entry.specSection);
    }
  });

  test("notImplementedErrorForCommand emits a tagged, phase-aware payload for every fixture entry", () => {
    for (const entry of fixture.commands) {
      const error = notImplementedErrorForCommand(entry.id);
      expect(error._tag).toBe("NotImplementedError");
      expect(error.commandId).toBe(entry.id);
      expect(error.specSection).toBe(entry.specSection);
      expect(error.message).toContain("Phase 2 Alpha");
      expect(error.remediation).toContain(entry.phase);
      expect(error.remediation).toContain("spec/ROADMAP.md");
      expect(error.remediation).not.toMatch(STACK_FRAME_PATTERN);
      expect(error.remediation).not.toMatch(SOURCE_FILE_PATH_PATTERN);
    }
  });

  test("every non-MVP compiled command has a registered deferral plan (no phase-less commands)", () => {
    const nonMvpIds = Object.keys(compiledCommands).filter((id) => !isMvpCommandId(id));
    const missing = nonMvpIds.filter((id) => deferredCommandPlan(id) === undefined);
    expect(missing, "every non-MVP compiled command id must be mapped in DEFERRED_COMMAND_PLANS").toEqual([]);
  });

  test("fixture only contains canonical command ids that exist in the compiled registry", () => {
    for (const entry of fixture.commands) {
      expect(
        Object.hasOwn(compiledCommands, entry.id),
        `${entry.id} must be registered in compiled-commands.ts`,
      ).toBe(true);
    }
  });

  describe("source OCLIF CLI", () => {
    for (const entry of fixture.commands) {
      test(`${entry.id} returns phase-tagged remediation`, async () => {
        const result = await runSource(entry.id);
        expect(result.exitCode, `${entry.id}: source exit code`).not.toBe(0);
        expectPhaseTaggedRemediation(result.stderr, entry);
      });
    }
  });

  describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled $bunfs CLI", () => {
    beforeAll(async () => {
      const build = await runProcess([process.execPath, "run", "build:compile"], undefined, coreRoot);
      expect(build.exitCode).toBe(0);
    }, 120_000);

    const collapseErrorBlock = (text: string): string =>
      extractErrorBlock(text)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" ")
        .replace(/\s+/g, " ");

    const parityProbes: ReadonlyArray<FixtureEntry> = [
      fixture.commands.find((entry) => entry.id === "apps:scratch:start") as FixtureEntry,
      fixture.commands.find((entry) => entry.id === "meta:global:start") as FixtureEntry,
      fixture.commands.find((entry) => entry.id === "meta:plugin:trust") as FixtureEntry,
    ];

    for (const entry of parityProbes) {
      test(`${entry.id}: source and compiled CLI emit semantically identical remediation`, async () => {
        const source = await runSource(entry.id);
        const compiled = await runCompiled(entry.id);
        expect(compiled.exitCode, `${entry.id}: exit code parity`).toBe(source.exitCode);
        expect(collapseErrorBlock(compiled.stderr), `${entry.id}: error block parity`).toBe(
          collapseErrorBlock(source.stderr),
        );
        expectPhaseTaggedRemediation(compiled.stderr, entry);
      }, 60_000);
    }
  });

  test("every plan entry surfaces a roadmap reference (Phase 3 Beta or Phase 4 RC)", () => {
    for (const [commandId, plan] of DEFERRED_COMMAND_PLANS) {
      expect(plan.remediation, `${commandId}: remediation must name target phase`).toContain(plan.phase);
      expect(plan.remediation, `${commandId}: remediation must reference spec/ROADMAP.md`).toContain(
        "spec/ROADMAP.md",
      );
      expect(plan.remediation, `${commandId}: remediation must not contain stack frames`).not.toMatch(
        STACK_FRAME_PATTERN,
      );
      expect(plan.remediation, `${commandId}: remediation must not embed source file paths`).not.toMatch(
        SOURCE_FILE_PATH_PATTERN,
      );
    }
  });
});
