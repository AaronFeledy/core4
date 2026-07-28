import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { runGate, writeGateResult } from "./boundary/format.ts";
import { BOUNDARY_RULES, BOUNDARY_RULE_IDS } from "./boundary/registry.ts";

const usage = "Usage: bun run scripts/check-boundaries.ts <rule-id>|--all|--list [--root=<path>]";

const rootArgument = (args: readonly string[]): string | undefined => {
  const explicit = args.find((argument) => argument.startsWith("--root="));
  if (explicit !== undefined) return explicit.slice("--root=".length);
  const index = args.indexOf("--root");
  return index === -1 ? undefined : args[index + 1];
};

const actionArguments = (args: readonly string[]): readonly string[] => {
  const actions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--root") {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--root=")) actions.push(argument);
  }
  return actions;
};

export const main = async (args: readonly string[]): Promise<void> => {
  const actions = actionArguments(args);
  const action = actions[0];
  if (actions.length !== 1 || action === undefined) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
    return;
  }

  if (action === "--list") {
    process.stdout.write(`${BOUNDARY_RULE_IDS.join("\n")}\n`);
    return;
  }

  const root = resolve(rootArgument(args) ?? resolve(import.meta.dirname, ".."));
  if (action === "--all") {
    const results = await runRules(BOUNDARY_RULE_IDS, root);
    for (const id of BOUNDARY_RULE_IDS) {
      const rule = BOUNDARY_RULES.get(id);
      const result = results.get(id);
      if (rule === undefined || result === undefined) {
        throw new TypeError(`Registered boundary rule produced no result: ${id}`);
      }
      writeGateResult(rule.passMessage, rule.failureHeadline, result);
    }
    return;
  }

  if (!BOUNDARY_RULES.has(action)) {
    process.stderr.write(`Unknown boundary rule: ${action}. Run with --list to see valid ids.\n`);
    process.exitCode = 1;
    return;
  }
  await runGate(action, root);
};

if (import.meta.main) await main(process.argv.slice(2));
