import { LineCounter, isAlias, isCollection, isNode, isPair, parseDocument } from "yaml";
import { limits } from "../diagnostics.ts";
import { indexWorkflowSource } from "../source-context.ts";
import { type LanguageSource, languageError, languageSource, sourceNameLimit } from "./errors.ts";

export interface AliasProvenance {
  readonly use: LanguageSource;
  readonly anchor: LanguageSource;
}
export type PreflightPolicy = "inspection" | "bounded-language";
export const preflightLanguage = (name: string, content: string, policy: PreflightPolicy) => {
  const source = { file: name };
  if (name.length > sourceNameLimit) throw languageError("source-limit", source);
  if (content.length > limits.fileBytes || new TextEncoder().encode(content).length > limits.fileBytes)
    throw languageError("file-limit", source);
  const counter = new LineCounter();
  const document = parseDocument(content, { uniqueKeys: false, lineCounter: counter });
  const at = (offset: number | undefined): LanguageSource => {
    const p = offset === undefined ? undefined : counter.linePos(offset);
    return languageSource({ file: name, ...(p === undefined ? {} : { line: p.line, column: p.col }) });
  };
  const syntax = document.errors[0];
  if (syntax !== undefined) throw languageError("yaml-syntax", at(syntax.pos[0]));
  const warning = document.warnings[0];
  if (policy === "bounded-language" && warning !== undefined)
    throw languageError("yaml-syntax", at(warning.pos[0]));
  const aliasProvenance: AliasProvenance[] = [];
  // Walk every expanded occurrence before the upstream reader can expand a single alias.
  const stack: { node: unknown; depth: number; ancestors: ReadonlySet<unknown> }[] = [
    { node: document.contents, depth: 1, ancestors: new Set() },
  ];
  let count = 0;
  let expandedBytes = 0;
  const scalarBytes = new Map<unknown, number>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { node, depth, ancestors } = item;
    const source = at(isNode(node) ? node.range?.[0] : undefined);
    if (++count > limits.nodes) throw languageError("yaml-nodes", source);
    if (depth > limits.depth) throw languageError("yaml-depth", source);
    if (isAlias(node)) {
      if (policy === "inspection") throw languageError("yaml-alias", source);
      const anchor = node.resolve(document);
      if (anchor === undefined) throw languageError("yaml-alias-unresolved", source);
      if (ancestors.has(anchor)) throw languageError("yaml-alias-cycle", source);
      if (aliasProvenance.length >= 1000) throw languageError("yaml-expansion-limit", source);
      aliasProvenance.push({ use: source, anchor: at(anchor.range?.[0]) });
      const next = new Set(ancestors);
      next.add(anchor);
      stack.push({ node: anchor, depth: depth + 1, ancestors: next });
    } else if (isCollection(node)) {
      if (count + stack.length + node.items.length > limits.nodes) throw languageError("yaml-nodes", source);
      for (let i = node.items.length - 1; i >= 0; i--)
        stack.push({ node: node.items[i], depth: depth + 1, ancestors });
    } else if (isPair(node)) {
      if (count + stack.length + 2 > limits.nodes) throw languageError("yaml-nodes", source);
      stack.push(
        { node: node.value, depth: depth + 1, ancestors },
        { node: node.key, depth: depth + 1, ancestors },
      );
    } else if (isNode(node)) {
      const range = node.range;
      let bytes = scalarBytes.get(node);
      if (bytes === undefined) {
        bytes = range == null ? 0 : new TextEncoder().encode(content.slice(range[0], range[1])).length;
        scalarBytes.set(node, bytes);
      }
      expandedBytes += bytes;
      if (expandedBytes > limits.fileBytes * 4) throw languageError("yaml-expansion-limit", source);
    }
  }
  return { sourceIndex: indexWorkflowSource(document.contents, counter), aliasProvenance };
};
