import { relative, resolve } from "node:path";

import { envHelperBoundaryRule } from "./architecture/rules/env-helper-boundary.ts";
import { runArchitectureChecks } from "./architecture/runner.ts";

export interface EnvHelperBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface EnvHelperBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<EnvHelperBoundaryOffender>;
}

interface CheckEnvHelperBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

export const checkEnvHelperBoundary = async (
  options: CheckEnvHelperBoundaryOptions = {},
): Promise<EnvHelperBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    rules: [envHelperBoundaryRule],
    auditExceptions: false,
  });
  const offenders = result.diagnostics.map(({ file, line, message }) => ({
    file: resolve(root, file),
    line: line ?? 1,
    specifier: message,
  }));

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: EnvHelperBoundaryOffender): string =>
  `${toRepoRelative(root, offender.file)}:${offender.line}: ${offender.specifier}`;

if (import.meta.main) {
  const result = await checkEnvHelperBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Env helper boundary check passed.\n");
  } else {
    process.stderr.write(
      `Env helper boundary check failed. Service files must not import lando.env helpers directly.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
