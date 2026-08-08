import ts from "typescript";

import type { BoundaryRule, FileContext } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

// Global objects whose `.fetch(...)` is a direct global-fetch call.
const GLOBAL_OBJECTS = new Set<string>(["globalThis", "Bun", "self", "window"]);

/**
 * Identify a direct global-fetch call expression. Returns the display match
 * (e.g. `fetch`, `globalThis.fetch`, `Bun.fetch`, `globalThis['fetch']`) or
 * `undefined` when the call is not a direct global fetch.
 *
 * Detected:
 *  - `fetch(...)` (bare identifier callee)
 *  - `globalThis.fetch(...)`, `Bun.fetch(...)`, `self.fetch(...)`, `window.fetch(...)`
 *  - `globalThis["fetch"](...)` element access on a global object
 *
 * NOT detected (intentionally):
 *  - `obj.fetch(...)` / `ctx.fetch(...)` method calls on arbitrary objects
 *  - `fetchImpl(...)` and other aliases
 *  - bare references like `?? globalThis.fetch` (no call)
 */
const matchGlobalFetchCall = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;

  if (ts.isIdentifier(callee) && callee.text === "fetch") return "fetch";

  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
    const target = callee.expression;
    if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text)) {
      return `${target.text}.fetch`;
    }
    return undefined;
  }

  if (ts.isElementAccessExpression(callee)) {
    const target = callee.expression;
    const argument = callee.argumentExpression;
    if (
      ts.isIdentifier(target) &&
      GLOBAL_OBJECTS.has(target.text) &&
      ts.isStringLiteralLike(argument) &&
      argument.text === "fetch"
    ) {
      return `${target.text}['fetch']`;
    }
  }

  return undefined;
};

const onNode = (node: ts.Node, context: FileContext): void => {
  if (!ts.isCallExpression(node)) return;
  const match = matchGlobalFetchCall(node);
  if (match === undefined) return;
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  context.report({ line: line + 1, detail: match });
};

export const networkRule = {
  id: "network",
  scope: {
    roots: CORE_AND_PLUGIN_SOURCE_ROOTS,
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: ["engine/src/http-client/live.ts"], prefixes: [] },
  passMessage: "Network boundary check passed.",
  failureHeadline:
    "Network boundary check failed. Lando-owned outbound HTTP must route through the HttpClient adapter (@lando/core HttpClient), not direct global fetch. Carve-outs are limited to BunSelfRunner package-manager ops and the standalone installer scripts.",
  onNode,
} satisfies BoundaryRule;
