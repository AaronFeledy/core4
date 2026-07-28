#!/usr/bin/env bun
import { resolve } from "node:path";

import { formatHumanReport, formatJsonReport } from "./architecture/format.ts";
import { getRules, isArchitectureRuleId, validRuleIdsMessage } from "./architecture/registry.ts";
import { runArchitectureChecks } from "./architecture/runner.ts";
import type { ArchitectureRuleId, RunOptions } from "./architecture/types.ts";

interface CliOptions {
  readonly root: string;
  readonly ruleIds: ReadonlyArray<ArchitectureRuleId>;
  readonly json: boolean;
}

type ParseResult =
  | { readonly kind: "valid"; readonly options: CliOptions }
  | { readonly kind: "invalid"; readonly message: string };

const parseArgs = (args: ReadonlyArray<string>): ParseResult => {
  const ruleIds: ArchitectureRuleId[] = [];
  let root = resolve(import.meta.dirname, "..");
  let json = false;
  for (const argument of args) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("--root=")) {
      root = resolve(argument.slice("--root=".length));
      continue;
    }
    if (argument.startsWith("--rule=")) {
      const ruleId = argument.slice("--rule=".length);
      if (!isArchitectureRuleId(ruleId)) {
        return {
          kind: "invalid",
          message: `Unknown architecture rule: ${ruleId}\n${validRuleIdsMessage()}\n`,
        };
      }
      ruleIds.push(ruleId);
      continue;
    }
    return { kind: "invalid", message: `Unknown argument: ${argument}\n${validRuleIdsMessage()}\n` };
  }
  return { kind: "valid", options: { root, ruleIds, json } };
};

export const runCheckArchitectureCli = async (args: ReadonlyArray<string>): Promise<number> => {
  const parsed = parseArgs(args);
  if (parsed.kind === "invalid") {
    process.stderr.write(parsed.message);
    return 1;
  }

  const selectedRules = getRules(parsed.options.ruleIds.length === 0 ? undefined : parsed.options.ruleIds);
  const runOptions: RunOptions =
    parsed.options.ruleIds.length === 0
      ? { root: parsed.options.root }
      : { root: parsed.options.root, ruleIds: parsed.options.ruleIds };
  const result = await runArchitectureChecks(runOptions);
  if (parsed.options.json) {
    process.stdout.write(formatJsonReport(result));
  } else if (result.ok) {
    process.stdout.write(
      `Architecture check passed (${selectedRules.length} rules, ${result.filesScanned} files scanned).\n`,
    );
  } else {
    process.stderr.write(formatHumanReport(result, selectedRules));
  }
  return result.ok ? 0 : 1;
};

if (import.meta.main) {
  try {
    process.exitCode = await runCheckArchitectureCli(process.argv.slice(2));
  } catch (error: unknown) {
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
