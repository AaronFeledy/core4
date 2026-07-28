import ts from "typescript";

import { resolveConstString, scanLiteralsAndComments } from "../literals.ts";
import type { BoundaryRule } from "../types.ts";

const PODMAN_5_PREFIX = /\/v5\.\d+\.\d+/g;

interface PrefixMatch {
  readonly value: string;
  readonly lineOffset: number;
}

const prefixMatches = (value: string): readonly PrefixMatch[] => {
  const matches: PrefixMatch[] = [];
  for (const match of value.matchAll(PODMAN_5_PREFIX)) {
    matches.push({
      value: match[0],
      lineOffset: value.slice(0, match.index).split("\n").length - 1,
    });
  }
  return matches;
};

const isStringComposition = (node: ts.Node): node is ts.BinaryExpression | ts.TemplateExpression =>
  ts.isTemplateExpression(node) ||
  (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);

const hasCompositionParent = (node: ts.Node): boolean => {
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (parent !== undefined && isStringComposition(parent)) return true;
  return parent !== undefined && ts.isTemplateSpan(parent) && ts.isTemplateExpression(parent.parent);
};

const onProgram: NonNullable<BoundaryRule["onProgram"]> = async (context) => {
  for (const file of context.files) {
    const source = await context.sourceFile(file);
    const directMatchRanges: Array<{ readonly start: number; readonly end: number }> = [];

    for (const literal of scanLiteralsAndComments(source)) {
      const matches = prefixMatches(literal.value);
      if (matches.length > 0) directMatchRanges.push({ start: literal.start, end: literal.end });
      for (const match of matches) {
        context.report(file.relativePath, literal.line + match.lineOffset, match.value);
      }
    }

    const visit = (node: ts.Node): void => {
      if (isStringComposition(node) && !hasCompositionParent(node)) {
        const containsDirectMatch = directMatchRanges.some(
          (range) => range.start >= node.getStart(source) && range.end <= node.getEnd(),
        );
        if (!containsDirectMatch) {
          const resolved = resolveConstString(node, source);
          if (resolved !== undefined) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            for (const match of prefixMatches(resolved)) {
              context.report(file.relativePath, line, match.value);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
};

export const libpodPrefixRule = {
  id: "libpod-prefix",
  scope: {
    roots: ["plugins"],
    extensions: [".ts"],
    excludeDirNames: ["test"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "libpod API prefix check passed.",
  failureHeadline:
    "libpod API prefix check failed. Production provider code must target the Podman 6 libpod API prefix (/v6.0.0), not a Podman 5 prefix (/v5.x.x). Migrate the offending prefixes:",
  onProgram,
} satisfies BoundaryRule;
