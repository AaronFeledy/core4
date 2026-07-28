import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { packageDagRule } from "./boundary/rules/package-dag.ts";

export interface PackageDagViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface PackageDagResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<PackageDagViolation>;
}

export interface CheckPackageDagOptions {
  readonly root: string;
}

export const checkPackageDag = async ({
  root: rootInput,
}: CheckPackageDagOptions): Promise<PackageDagResult> => {
  const root = resolve(rootInput);
  const results = await runRules([packageDagRule.id], root);
  const result = results.get(packageDagRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${packageDagRule.id}`);
  return {
    ok: result.ok,
    violations: result.violations.map((violation) => ({
      file: violation.file,
      line: violation.line,
      specifier: violation.detail,
    })),
  };
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
