import { isLandofileOverride, isPlainRecord } from "@lando/sdk/landofile";
import type { ConfigLintViolation, ValidationIssuePath } from "@lando/sdk/schema";
import type { SchemaIssue } from "effect";
import { Predicate } from "effect";
import type { ComposeDocumentPath, ComposeRejectionMatch } from "./compose/rejections.ts";
import { landofileIssuesFromSchema } from "./validation-suggestions.ts";

export const rejectionViolation = (match: ComposeRejectionMatch): ConfigLintViolation => ({
  rule: "landofile.compose-rejection",
  severity: "error",
  path: match.path,
  message: `Compose key "${match.matrixPath}" is rejected: ${match.rationale}`,
  suggestion: match.remediation,
});

const startsWith = (path: ValidationIssuePath, prefix: ComposeDocumentPath): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
const samePath = (left: ValidationIssuePath, right: ComposeDocumentPath): boolean =>
  left.length === right.length && startsWith(left, right);

/** Locations whose schema findings a Compose rejection finding already reports. */
export interface RejectionCoverage {
  readonly rejected: ReadonlyArray<ComposeDocumentPath>;
  /** Objects that held keys before pruning and none after it. */
  readonly emptied: ReadonlyArray<ComposeDocumentPath>;
}

interface PrunedDocument {
  readonly document: unknown;
  readonly covered: RejectionCoverage;
}

/**
 * Copies `value` with every rejected object key deleted. Arrays keep their length and positions,
 * so every other path still addresses the authored value.
 */
const pruneAt = (
  value: unknown,
  suffixes: ReadonlyArray<ComposeDocumentPath>,
  at: ComposeDocumentPath,
  emptied: ComposeDocumentPath[],
): unknown => {
  if (isLandofileOverride(value)) return { ...value, value: pruneAt(value.value, suffixes, at, emptied) };
  const children = new Map<string | number, ComposeDocumentPath[]>();
  const removed = new Set<string>();
  for (const [head, ...rest] of suffixes) {
    if (head === undefined) continue;
    if (rest.length === 0 && typeof head === "string") removed.add(head);
    else children.set(head, [...(children.get(head) ?? []), rest]);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const nested = children.get(index);
      return nested === undefined ? item : pruneAt(item, nested, [...at, index], emptied);
    });
  }
  if (!isPlainRecord(value)) return value;
  // A spread keeps symbol-keyed merge-directive markers.
  const pruned: Record<string, unknown> = { ...value };
  for (const key of removed) delete pruned[key];
  for (const [key, nested] of children) {
    if (typeof key === "string" && key in pruned)
      pruned[key] = pruneAt(pruned[key], nested, [...at, key], emptied);
  }
  if (Object.keys(value).length > 0 && Object.keys(pruned).length === 0) emptied.push(at);
  return pruned;
};

/**
 * The document lint decodes for schema findings: rejected keys removed so a rejection is reported
 * once, by its Compose rejection finding. Diagnostic only; loading and planning keep the original.
 */
export const pruneRejectedKeys = (
  document: unknown,
  rejections: readonly ComposeRejectionMatch[],
): PrunedDocument => {
  const rejected = rejections.map(({ path }) => path);
  if (rejected.length === 0) return { document, covered: { rejected, emptied: [] } };
  const emptied: ComposeDocumentPath[] = [];
  return { document: pruneAt(document, rejected, [], emptied), covered: { rejected, emptied } };
};

/**
 * Schema findings for `parsed`. A finding inside a rejected path, or at an object that only pruning
 * emptied, restates a rejection finding and is dropped; every other finding is an independent problem.
 */
export const violationsFromSchema = (
  issue: SchemaIssue.Issue,
  parsed: unknown,
  covered: RejectionCoverage = { rejected: [], emptied: [] },
): readonly ConfigLintViolation[] =>
  landofileIssuesFromSchema(issue, parsed)
    .map((issue): ConfigLintViolation => ({ ...issue, rule: "landofile.validation", severity: "error" }))
    // Rejection analysis belongs to a single source document, not the merged effective value.
    .filter(
      (violation) =>
        !covered.rejected.some((path) => startsWith(violation.path, path)) &&
        !covered.emptied.some((path) => samePath(violation.path, path)),
    );

export const appNameOf = (parsed: unknown): string => {
  if (!Predicate.isObject(parsed)) return "";
  return typeof parsed.name === "string" ? parsed.name : "";
};
