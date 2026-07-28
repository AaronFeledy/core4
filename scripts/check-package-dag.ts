import { resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";
import type { Diagnostic } from "./architecture/types.ts";

export interface PackageDagViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface PackageDagResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<PackageDagViolation>;
}

interface CheckPackageDagOptions {
  readonly root: string;
}

const toViolation = (diagnostic: Diagnostic): PackageDagViolation => {
  if (diagnostic.line === undefined) {
    throw new TypeError(`Package DAG diagnostic is missing a line: ${diagnostic.file}`);
  }
  return { file: diagnostic.file, line: diagnostic.line, specifier: diagnostic.message };
};

export const checkPackageDag = async ({ root }: CheckPackageDagOptions): Promise<PackageDagResult> => {
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["package-dag"],
    auditExceptions: false,
  });
  const violations = (result.byRule.get("package-dag") ?? []).map(toViolation);
  return { ok: violations.length === 0, violations };
};

const rootArgument = (args: ReadonlyArray<string>): string | undefined => {
  const index = args.indexOf("--root");
  if (index >= 0) return args[index + 1];
  return args.find((argument) => argument.startsWith("--root="))?.slice("--root=".length);
};

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const root = resolve(rootArgument(process.argv.slice(2)) ?? resolve(import.meta.dirname, ".."));
  const result = await checkPackageDag({ root });
  const details = result.violations.map(
    (violation) => `${violation.file}:${violation.line}: ${violation.specifier}`,
  );
  const output = `${details.length === 0 ? "" : `${details.join("\n")}\n`}Package DAG violations: ${details.length}\n`;
  if (report) {
    process.stdout.write(output);
  } else if (result.ok) {
    process.stdout.write("Package DAG check passed.\n");
  } else {
    process.stderr.write(`Package DAG check failed. Fix package dependency direction:\n${output}`);
    process.exitCode = 1;
  }
}
