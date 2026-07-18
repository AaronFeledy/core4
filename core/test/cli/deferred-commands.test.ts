import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";
import {
  DEFERRED_COMMAND_PLANS,
  deferredCommandPlan,
  notImplementedErrorForCommand,
} from "../../src/cli/deferred-commands.ts";
import { isMvpCommandId } from "../../src/cli/oclif/command-base.ts";

import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";

interface FixtureEntry {
  readonly id: string;
}

interface FixtureFile {
  readonly commands: ReadonlyArray<FixtureEntry>;
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
let compiledBinary = "";
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

const expectDeferredRemediation = (stderr: string, entry: FixtureEntry): void => {
  expect(stderr, `${entry.id}: stderr must contain the NotImplementedError tag`).toContain(
    "NotImplementedError",
  );
  expect(stderr, `${entry.id}: stderr must echo the commandId`).toContain(`commandId: ${entry.id}`);
  expect(stderr, `${entry.id}: stderr must include remediation`).toContain("↳");
  expect(stderr, `${entry.id}: stderr must explain availability`).toContain("available");

  const errorBlock = extractErrorBlock(stderr);
  expect(errorBlock.length, `${entry.id}: error block must be non-empty`).toBeGreaterThan(0);
  expectNoStackOrSourcePaths(errorBlock, entry.id);
};

describe("deferred command remediation contract", () => {
  test("fixture covers every required command surface", () => {
    const ids = new Set(fixture.commands.map((entry) => entry.id));
    const requiredExactIds = ["meta:plugin:login"];
    for (const id of requiredExactIds) {
      expect(ids.has(id), `requires fixture entry for ${id}`).toBe(true);
    }
  });

  test("meta:global:rebuild is implemented, not deferred", () => {
    expect(deferredCommandPlan("meta:global:rebuild")).toBeUndefined();
    expect(isMvpCommandId("meta:global:rebuild")).toBe(true);
  });

  test("DEFERRED_COMMAND_PLANS covers every fixture entry", () => {
    for (const entry of fixture.commands) {
      const plan = deferredCommandPlan(entry.id);
      expect(plan, `${entry.id} must have a registered deferral plan`).toBeDefined();
    }
  });

  test("notImplementedErrorForCommand emits a tagged payload for every fixture entry", () => {
    for (const entry of fixture.commands) {
      const error = notImplementedErrorForCommand(entry.id);
      expect(error._tag).toBe("NotImplementedError");
      expect(error.commandId).toBe(entry.id);
      expect(error.message).toContain("not implemented");
      expect(error.remediation).toContain("not available yet");
      expect(error.remediation).not.toMatch(STACK_FRAME_PATTERN);
      expect(error.remediation).not.toMatch(SOURCE_FILE_PATH_PATTERN);
    }
  });

  test("every non-MVP compiled command has a registered deferral plan", () => {
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
      test(`${entry.id} returns deferred remediation`, async () => {
        const result = await runSource(entry.id);
        expect(result.exitCode, `${entry.id}: source exit code`).not.toBe(0);
        expectDeferredRemediation(result.stderr, entry);
      });
    }
  });

  describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled $bunfs CLI", () => {
    beforeAll(async () => {
      compiledBinary = await ensureCompiledCli();
    }, 120_000);

    const collapseErrorBlock = (text: string): string =>
      extractErrorBlock(text)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" ")
        .replace(/\s+/g, " ");

    const parityProbes: ReadonlyArray<FixtureEntry> = [
      fixture.commands.find((entry) => entry.id === "meta:plugin:login") as FixtureEntry,
    ];

    for (const entry of parityProbes) {
      test(`${entry.id}: source and compiled CLI emit semantically identical remediation`, async () => {
        const source = await runSource(entry.id);
        const compiled = await runCompiled(entry.id);
        expect(compiled.exitCode, `${entry.id}: exit code parity`).toBe(source.exitCode);
        expect(collapseErrorBlock(compiled.stderr), `${entry.id}: error block parity`).toBe(
          collapseErrorBlock(source.stderr),
        );
        expectDeferredRemediation(compiled.stderr, entry);
      }, 60_000);
    }
  });

  test("every plan entry surfaces actionable remediation", () => {
    for (const [commandId, plan] of DEFERRED_COMMAND_PLANS) {
      expect(plan.remediation, `${commandId}: remediation must explain availability`).toContain(
        "not available yet",
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
