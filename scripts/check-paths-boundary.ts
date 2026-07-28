import * as fs from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface PathsBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface PathsBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<PathsBoundaryOffender>;
}

interface CheckPathsBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"];

// The single primitive module is the only place these root joins may live.
const PRIMITIVE_MODULE = "core/src/config/paths.ts";

// Empty by design: migrate offenders into the primitive, do not carve out.
const CARVE_OUTS = new Set<string>();

// Each forbidden join pairs a root-identifier suffix with a literal segment.
const FORBIDDEN_JOINS: ReadonlyArray<{ readonly rootSuffix: string; readonly segment: string }> = [
  { rootSuffix: "userdataroot", segment: "plugins" },
  { rootSuffix: "usercacheroot", segment: "scratch" },
  { rootSuffix: "userdataroot", segment: "bin" },
];

const JOIN_CALLEES = new Set(["join", "resolve"]);

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
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

const calleeName = (expression: ts.LeftHandSideExpression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const rootIdentifierSuffix = (node: ts.Expression): string | undefined => {
  const name = ts.isIdentifier(node)
    ? node.text
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : undefined;
  return name?.toLowerCase();
};

const literalText = (node: ts.Expression): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

const isForbiddenJoin = (call: ts.CallExpression): boolean => {
  const callee = calleeName(call.expression);
  if (callee === undefined || !JOIN_CALLEES.has(callee)) return false;
  const [first, second] = call.arguments;
  if (first === undefined || second === undefined) return false;
  const suffix = rootIdentifierSuffix(first);
  const segment = literalText(second);
  if (suffix === undefined || segment === undefined) return false;
  return FORBIDDEN_JOINS.some((entry) => suffix.endsWith(entry.rootSuffix) && segment === entry.segment);
};

const scanFile = async (file: string): Promise<ReadonlyArray<PathsBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: PathsBoundaryOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isForbiddenJoin(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offenders.push({ file, line: line + 1, snippet: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkPathsBoundary = async (
  options: CheckPathsBoundaryOptions = {},
): Promise<PathsBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (await Promise.all(SCANNED_ROOTS.map((scanned) => collectTsFiles(resolve(root, scanned)))))
    .flat()
    .filter((file) => {
      const rel = toRepoRelative(root, file);
      return rel !== PRIMITIVE_MODULE && !CARVE_OUTS.has(rel);
    })
    .sort();

  const offenders = (await Promise.all(files.map((file) => scanFile(file))))
    .flat()
    .sort(
      (left, right) =>
        toRepoRelative(root, left.file).localeCompare(toRepoRelative(root, right.file)) ||
        left.line - right.line,
    );

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: PathsBoundaryOffender): string =>
  `${toRepoRelative(root, offender.file)}:${offender.line}: ${offender.snippet}`;

if (import.meta.main) {
  const result = await checkPathsBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Paths boundary check passed.\n");
  } else {
    process.stderr.write(
      `Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
