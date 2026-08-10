import { dirname, join, normalize } from "node:path/posix";

import ts from "typescript";

import { resolveConstString } from "../literals.ts";
import type { BoundaryRule } from "../types.ts";

/**
 * The specification tree is authored material, not a shipped part of this
 * repository: it may be deleted at any time. Only files inside it may cite or
 * read it. Everything else must state the durable detail itself.
 */
const SPEC_ROOT = "spec";

/** A section-sign citation such as `§1.2` or `spec §8.9.3`. */
const SECTION_CITATION = /§\s*\d/u;

/**
 * A path-shaped token whose last-but-one segment is `spec`, e.g.
 * `spec/06-services.md`, `../spec/README.md`, or `../../src/cli/spec/metadata`.
 * Matching alone proves nothing: `resolvesIntoSpecTree` decides whether the
 * token actually points at the repository-root specification tree, so the
 * unrelated `core/src/cli/spec/**` CLI directory is not mistaken for it.
 */
const SPEC_PATH_TOKEN =
  /(?<![\w-])((?:\.{1,2}\/)*(?:[A-Za-z0-9_.-]+\/)*spec\/[A-Za-z0-9_.-][A-Za-z0-9_./-]*)/gu;

/** True when `token`, read from `fileRelativePath`, lands inside the specification tree. */
const resolvesIntoSpecTree = (token: string, fileRelativePath: string): boolean => {
  const resolved = token.startsWith(".") ? join(dirname(fileRelativePath), token) : normalize(token);
  return resolved === SPEC_ROOT || resolved.startsWith(`${SPEC_ROOT}/`);
};

/** True when any specification-tree path appears on `line`. */
const citesSpecPath = (line: string, fileRelativePath: string): boolean => {
  for (const match of line.matchAll(SPEC_PATH_TOKEN)) {
    const token = match[1];
    if (token !== undefined && resolvesIntoSpecTree(token, fileRelativePath)) return true;
  }
  return false;
};

/** The legacy `// SPEC: §10.2` comment banner convention. */
const SPEC_BANNER = /\bSPEC:/u;

/** Prose that points at the specification, e.g. `spec §7.4`. */
const SPEC_POINTER = /\bspec\b\s*[§#]/u;

const TEXT_PATTERNS = [
  { pattern: SECTION_CITATION, detail: "section-sign citation" },
  { pattern: SPEC_BANNER, detail: "SPEC: comment banner" },
  { pattern: SPEC_POINTER, detail: "specification pointer" },
] as const;

/** Call targets whose string argument is a filesystem path. */
const PATH_CALLEES = new Set(["resolve", "join", "readdir", "readFile", "file"]);

const AST_EXTENSIONS = [".ts", ".tsx"];

const firstTextViolation = (line: string, fileRelativePath: string): string | undefined => {
  if (citesSpecPath(line, fileRelativePath)) return "specification path reference";
  return TEXT_PATTERNS.find((candidate) => candidate.pattern.test(line))?.detail;
};

const isPathCall = (node: ts.Node): boolean => {
  const call = node.parent;
  if (call === undefined || !ts.isCallExpression(call)) return false;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return PATH_CALLEES.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && PATH_CALLEES.has(callee.name.text);
};

const onProgram: NonNullable<BoundaryRule["onProgram"]> = async (context) => {
  for (const file of context.files) {
    const text = await context.text(file);
    const reported = new Set<number>();

    text.split("\n").forEach((line, index) => {
      const detail = firstTextViolation(line, file.relativePath);
      if (detail !== undefined) {
        reported.add(index + 1);
        context.report(file.relativePath, index + 1, detail);
      }
    });

    if (!AST_EXTENSIONS.some((extension) => file.relativePath.endsWith(extension))) continue;

    // Catch constructed paths (concatenation, templates, const aliases, and
    // `[...].join()`) that never appear verbatim in the file text.
    const source = await context.sourceFile(file);
    const visit = (node: ts.Node): void => {
      if (ts.isExpression(node) && !ts.isStringLiteralLike(node)) {
        const resolved = resolveConstString(node, source);
        if (
          resolved !== undefined &&
          (citesSpecPath(resolved, file.relativePath) || resolved === SPEC_ROOT)
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          if (!reported.has(line)) {
            reported.add(line);
            context.report(file.relativePath, line, `constructed specification path: ${resolved}`);
          }
        }
      }
      if (ts.isStringLiteralLike(node) && node.text === SPEC_ROOT && isPathCall(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (!reported.has(line)) {
          reported.add(line);
          context.report(file.relativePath, line, "specification tree path argument");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
};

export const specReferenceRule = {
  id: "spec-reference",
  scope: {
    roots: [""],
    extensions: [".md", ".mdx", ".ts", ".tsx", ".json", ".yml", ".yaml"],
    excludeDirNames: ["node_modules", "dist", ".git", ".local", "coverage", "generated"],
    excludePrefixes: [`${SPEC_ROOT}/`],
    // The detector and its fixtures must spell the patterns they detect.
    excludeFiles: [
      "scripts/boundary/rules/spec-reference.ts",
      "core/test/scripts/check-spec-reference.test.ts",
    ],
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Spec reference boundary check passed.",
  failureHeadline:
    "Spec reference boundary check failed. Only files under the specification tree may cite or read it; the specification is not a permanent part of this codebase. Replace each citation with the durable detail it describes. If a generated artifact is flagged, re-run `bun run codegen`:",
  onProgram,
} satisfies BoundaryRule;
