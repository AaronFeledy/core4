#!/usr/bin/env bun
/**
 * Local, source-based unit-test selection. This is a review aid; CI still runs
 * its complete selected shards. Paths and witnesses are repository-relative.
 */
import { resolve } from "node:path";

import { GitChangeError, discoverChanges } from "./git-changes.ts";
import { affectedGuideRunPlan } from "./guides/affected-guide-run.ts";
import { selectAffectedGuides } from "./guides/affected-guides.ts";
import { printGuides, printUnitSelection } from "./test-affected-report.ts";
import { runAffectedChildren } from "./test-affected-run.ts";
import { selectAffectedTests } from "./test-affected-selection.ts";

const ROOT = resolve(import.meta.dirname, "..");

const parseArgs = (args: readonly string[]): { base: string; files: string[]; run: boolean } => {
  let base = "origin/main";
  const files: string[] = [];
  let run = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") run = true;
    else if (arg === "--base" || arg === "--file") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--base") base = value;
      else files.push(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { base, files, run };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const changed = args.files.length
    ? args.files
    : (await discoverChanges(ROOT, { kind: "working-tree", baseRef: args.base })).paths;
  const result = await selectAffectedTests({ changed, baseRef: args.base });
  const guideSelection = await selectAffectedGuides({ root: ROOT, changed: result.changed });
  const plan = affectedGuideRunPlan(guideSelection, process.env);

  printUnitSelection({
    result,
    base: args.base,
    explicitPaths: args.files.length > 0,
    guideSelectedPaths: new Set(guideSelection.selectedPaths),
  });
  if (guideSelection.diagnostics.length > 0) {
    for (const diagnostic of guideSelection.diagnostics)
      console.log(`  home-guide: ${diagnostic.code}: ${diagnostic.message}`);
    process.exitCode = 1;
    return;
  }
  printGuides(plan);
  if (!args.run) return;
  process.exitCode = await runAffectedChildren({
    root: ROOT,
    unitFiles: result.selected,
    plan,
    env: process.env,
  });
};

const run = async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    if (error instanceof GitChangeError) {
      process.stderr.write(`${error._tag}: ${error.message}\n${error.remediation}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
};

if (import.meta.main) await run();
