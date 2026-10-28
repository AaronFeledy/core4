import { LineCounter, isAlias, isCollection, isNode, isPair, parseDocument } from "yaml";
import { diagnostic, limits, location } from "./diagnostics.ts";
import type { WorkflowDiagnostic } from "./schema.ts";
import { type WorkflowSourceIndex, indexWorkflowSource } from "./source-context.ts";

export const preflight = (
  name: string,
  content: string,
):
  | { readonly status: "accepted"; readonly index: WorkflowSourceIndex }
  | { readonly status: "rejected"; readonly diagnostic: WorkflowDiagnostic } => {
  const counter = new LineCounter();
  const document = parseDocument(content, { uniqueKeys: false, lineCounter: counter });
  const position = (offset: number) => {
    const value = counter.linePos(offset);
    return { line: value.line, column: value.col };
  };
  const syntax = document.errors[0];
  const reject = (item: WorkflowDiagnostic) => ({ status: "rejected" as const, diagnostic: item });
  if (syntax !== undefined) return reject(diagnostic("yaml-syntax", location(name, position(syntax.pos[0]))));
  const pending: { readonly node: unknown; readonly depth: number }[] = [
    { node: document.contents, depth: 1 },
  ];
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    const { node, depth } = item;
    const offset = isNode(node) ? node.range?.[0] : undefined;
    const source = location(name, offset === undefined ? undefined : position(offset));
    if (++count > limits.nodes) return reject(diagnostic("yaml-nodes", source));
    if (depth > limits.depth) return reject(diagnostic("yaml-depth", source));
    if (isAlias(node)) return reject(diagnostic("yaml-alias", source));
    if (isCollection(node)) {
      if (count + pending.length + node.items.length > limits.nodes)
        return reject(diagnostic("yaml-nodes", source));
      for (let index = node.items.length - 1; index >= 0; index--)
        pending.push({ node: node.items[index], depth: depth + 1 });
    } else if (isPair(node)) {
      if (count + pending.length + 2 > limits.nodes) return reject(diagnostic("yaml-nodes", source));
      pending.push({ node: node.value, depth: depth + 1 }, { node: node.key, depth: depth + 1 });
    }
  }
  return { status: "accepted", index: indexWorkflowSource(document.contents, counter) };
};
