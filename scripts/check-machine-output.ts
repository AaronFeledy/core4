import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { runGate } from "./boundary/format.ts";

export interface MachineOutputOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface MachineOutputResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<MachineOutputOffender>;
}

interface CheckMachineOutputOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkMachineOutput = async (
  options: CheckMachineOutputOptions = {},
): Promise<MachineOutputResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules(["machine-output"], root);
  const result = results.get("machine-output");
  if (result === undefined) throw new TypeError("Machine output boundary rule produced no result");
  return {
    ok: result.ok,
    offenders: result.violations.map((violation) => ({
      file: resolve(root, violation.file),
      line: violation.line,
      match: violation.detail,
    })),
  };
};

if (import.meta.main) await runGate("machine-output", repoRoot);
