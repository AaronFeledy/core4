import type { ConfigLintViolation, ValidationIssue } from "@lando/sdk/schema";
import type { SourceDocument } from "./pipeline/source-table.ts";

export const sourceCoordinates = (source: SourceDocument, path: readonly (string | number)[]) => {
  if (source.form !== "yaml" || /^template:/m.test(source.content)) return {};
  const parents: { indent: number; path: readonly (string | number)[] }[] = [];
  const indexes = new Map<string, number>();
  const lines = source.content.split("\n");
  const matches = (current: readonly (string | number)[]) =>
    current.length === path.length && current.every((part, position) => part === path[position]);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    while (parents.length > 0 && (parents[parents.length - 1]?.indent ?? -1) >= indent) parents.pop();
    const parent = parents[parents.length - 1]?.path ?? [];
    const sequence = /^\s*-\s+/.test(line);
    const key = /^\s*(?:-\s+)?([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line)?.[1];
    let current = parent;
    if (sequence) {
      const identity = JSON.stringify(parent);
      const next = (indexes.get(identity) ?? -1) + 1;
      indexes.set(identity, next);
      current = [...parent, next];
      if (matches(current)) return { line: index + 1, column: indent + 1 };
      if (key !== undefined) parents.push({ indent, path: current });
    }
    if (key !== undefined) current = [...current, key];
    if (matches(current)) return { line: index + 1, column: indent + 1 };
    parents.push({ indent: sequence && key !== undefined ? indent + 2 : indent, path: current });
  }
  return {};
};

export const attributeLintIssue = (
  issue: ValidationIssue & Partial<Pick<ConfigLintViolation, "rule" | "severity">>,
  scope: "fragment" | "effective",
  documents: readonly SourceDocument[],
): ConfigLintViolation => {
  const source = issue.source;
  const retained =
    source === undefined
      ? undefined
      : documents.find((document) => document.file === source.file && document.layer === source.layer);
  return {
    ...issue,
    rule: issue.rule ?? "landofile.validation",
    severity: issue.severity ?? "error",
    scopes: [scope],
    ...(retained === undefined || source === undefined ? {} : sourceCoordinates(retained, source.path)),
  };
};
