import ts from "typescript";

import { resolveConstString, scanLiteralsAndComments } from "../literals.ts";
import type { BoundaryRule } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

const SENTINELS = ["lando-generated", ">>> lando:", "<<< lando:"] as const;

const onProgram: NonNullable<BoundaryRule["onProgram"]> = async (context) => {
  for (const file of context.files) {
    const source = await context.sourceFile(file);
    const hits = new Map<number, (typeof SENTINELS)[number]>();
    const record = (line: number, sentinel: (typeof SENTINELS)[number]): void => {
      const current = hits.get(line);
      if (current === undefined || SENTINELS.indexOf(sentinel) < SENTINELS.indexOf(current)) {
        hits.set(line, sentinel);
      }
    };

    for (const value of scanLiteralsAndComments(source)) {
      const raw = source.text.slice(value.start, value.end);
      for (const sentinel of SENTINELS) {
        for (let index = raw.indexOf(sentinel); index >= 0; index = raw.indexOf(sentinel, index + 1)) {
          const { line } = source.getLineAndCharacterOfPosition(value.start + index);
          record(line + 1, sentinel);
        }
        if (value.value.includes(sentinel) && !raw.includes(sentinel)) record(value.line, sentinel);
      }
    }

    const visit = (node: ts.Node): void => {
      const isConcatenation =
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
      if (isConcatenation || ts.isTemplateExpression(node)) {
        const value = resolveConstString(node, source);
        const sentinel = value === undefined ? undefined : SENTINELS.find((item) => value.includes(item));
        if (sentinel !== undefined) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          record(line + 1, sentinel);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    for (const [line, detail] of [...hits].sort(([left], [right]) => left - right)) {
      context.report(file.relativePath, line, detail);
    }
  }
};

export const managedFileRule = {
  id: "managed-file",
  scope: {
    roots: CORE_AND_PLUGIN_SOURCE_ROOTS.filter((root) => root !== "managed-file/src"),
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Managed-file boundary check passed.",
  failureHeadline:
    "Managed-file boundary check failed. Host project-file ownership-marker/overwrite logic must route through @lando/managed-file.",
  onProgram,
} satisfies BoundaryRule;
