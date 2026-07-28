import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { runGate } from "./boundary/format.ts";

export interface LibpodPrefixOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface LibpodPrefixResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<LibpodPrefixOffender>;
}

interface CheckLibpodPrefixOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkLibpodPrefix = async (
  options: CheckLibpodPrefixOptions = {},
): Promise<LibpodPrefixResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules(["libpod-prefix"], root);
  const result = results.get("libpod-prefix");
  if (result === undefined) throw new TypeError("Boundary rule produced no result: libpod-prefix");
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
  await runGate("libpod-prefix", repoRoot);
}
