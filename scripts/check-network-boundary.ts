import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { runGate } from "./boundary/format.ts";

export interface NetworkBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface NetworkBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<NetworkBoundaryOffender>;
}

interface CheckNetworkBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkNetworkBoundary = async (
  options: CheckNetworkBoundaryOptions = {},
): Promise<NetworkBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules(["network"], root);
  const result = results.get("network");
  if (result === undefined) throw new TypeError("Boundary rule produced no result: network");
  return {
    ok: result.ok,
    offenders: result.violations.map((violation) => ({
      file: violation.file,
      line: violation.line,
      match: violation.detail,
    })),
  };
};

if (import.meta.main) {
  await runGate("network", repoRoot);
}
