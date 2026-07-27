import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface RendererBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface RendererBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<RendererBoundaryOffender>;
}

interface CheckRendererBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkRendererBoundary = async (
  options: CheckRendererBoundaryOptions = {},
): Promise<RendererBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["renderer-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics
    .map((diagnostic): RendererBoundaryOffender => {
      if (diagnostic.line === undefined) {
        throw new TypeError("Renderer boundary diagnostic is missing a line number");
      }
      return {
        file: resolve(root, diagnostic.file),
        line: diagnostic.line,
        match: diagnostic.message,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: RendererBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkRendererBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Renderer boundary check passed.\n");
  } else {
    process.stderr.write(
      `Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
