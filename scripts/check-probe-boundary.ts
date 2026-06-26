import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface ProbeBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface ProbeBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<ProbeBoundaryOffender>;
}

interface CheckProbeBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;

// Pre-existing non-probe retry/Schedule uses are explicitly allowlisted so the
// gate locks the single retry/backoff/verdict primitive (@lando/sdk/probe) for
// host/provider-shaped probing without blocking unrelated synchronization.
const CARVE_OUTS = new Set<string>([
  // Advisory state lockfile acquisition: a bounded retry on O_EXCL contention,
  // not a probe-to-verdict loop.
  "core/src/state/lock.ts",
  // State-bucket lockfile acquisition: same advisory-lock retry shape.
  "core/src/state-store/json-bucket.ts",
]);

// `Effect.<member>(...)` calls that are hand-rolled retry/backoff primitives.
const FORBIDDEN_EFFECT_MEMBERS = new Set(["retry", "repeat", "schedule"]);

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const scanFile = async (file: string): Promise<ReadonlyArray<ProbeBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: ProbeBoundaryOffender[] = [];

  const record = (node: ts.Node, match: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    offenders.push({ file, line: line + 1, match });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const object = node.expression.text;
      const member = node.name.text;

      // `Effect.retry` / `Effect.repeat` / `Effect.schedule` — hand-rolled
      // retry/backoff loops.
      if (object === "Effect" && FORBIDDEN_EFFECT_MEMBERS.has(member)) {
        record(node, `Effect.${member}`);
      }

      // `Schedule.<anything>` — any direct Schedule construction.
      if (object === "Schedule") {
        record(node, `Schedule.${member}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkProbeBoundary = async (
  options: CheckProbeBoundaryOptions = {},
): Promise<ProbeBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const offenders = (
    await Promise.all(
      files.map(async (file) => {
        const relativeFile = relative(root, file).replaceAll("\\", "/");
        if (CARVE_OUTS.has(relativeFile)) return [];
        return scanFile(file);
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: ProbeBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkProbeBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Probe boundary check passed.\n");
  } else {
    process.stderr.write(
      `Probe boundary check failed. Host/provider-shaped retry/backoff/timeout-to-verdict probing must build on @lando/sdk/probe (runProbe), not hand-rolled Effect.retry/repeat/schedule or Schedule loops.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
