/**
 * Source-span indexing for a parsed Lando 3 document.
 *
 * The `LEGACY` parser hands back two views of one file: a lossless source tree
 * whose nodes each carry a span, and a projected plain value with aliases and
 * merge keys already resolved. Diagnostics quote the projected value but must
 * point at real source text, so this module walks the tree once and records a
 * span for every authored path.
 *
 * Alias nodes are recorded and not descended. The projected value gains the
 * anchor's fields at that path, but the text the reader can edit is the alias
 * itself, so the alias span is the honest target for anything merged in
 * through it. `lookupSpan` falls back to the nearest recorded ancestor, which
 * makes that substitution automatic and guarantees every path resolves.
 */
import type { LegacyNode, LegacySourceSpan } from "@lando/sdk/landofile";
import type { Lando3Path } from "./contract.ts";

export type { Lando3Path } from "./contract.ts";

/** YAML's merge key. Its entry contributes the target's fields, not a key. */
const MERGE_KEY = "<<";

const SEPARATOR = "\u0000";

export const pathKey = (path: Lando3Path): string => path.join(SEPARATOR);

/** Renders a path the way a reader would type it: `services.web.build[0]`. */
export const formatPath = (path: Lando3Path): string =>
  path.reduce<string>(
    (rendered, segment) =>
      typeof segment === "number"
        ? `${rendered}[${segment}]`
        : rendered === ""
          ? segment
          : `${rendered}.${segment}`,
    "",
  );

export interface Lando3SpanIndex {
  readonly spans: ReadonlyMap<string, LegacySourceSpan>;
  readonly identityNames: ReadonlyMap<string, string>;
  readonly root: LegacySourceSpan | undefined;
}

const indexNode = (
  node: LegacyNode,
  path: Lando3Path,
  index: { readonly spans: Map<string, LegacySourceSpan>; readonly identityNames: Map<string, string> },
): void => {
  const name = node.kind === "alias" ? node.name : node.anchor;
  if (name !== undefined) index.identityNames.set(pathKey(path), name);
  switch (node.kind) {
    case "mapping": {
      for (const entry of node.entries) {
        if (entry.key.text === MERGE_KEY) continue;
        const entryPath = [...path, entry.key.text];
        index.spans.set(pathKey(entryPath), entry.span);
        indexNode(entry.value, entryPath, index);
      }
      return;
    }
    case "sequence": {
      node.items.forEach((item, offset) => {
        const itemPath = [...path, offset];
        index.spans.set(pathKey(itemPath), item.span);
        indexNode(item, itemPath, index);
      });
      return;
    }
    default:
      return;
  }
};

export const indexLegacySpans = (root: LegacyNode | null): Lando3SpanIndex => {
  const spans = new Map<string, LegacySourceSpan>();
  const identityNames = new Map<string, string>();
  if (root === null) return { spans, identityNames, root: undefined };
  spans.set(pathKey([]), root.span);
  indexNode(root, [], { spans, identityNames });
  return { spans, identityNames, root: root.span };
};

/** Identity is exact-path only: an alias's children are not that alias itself. */
export const lookupIdentityName = (index: Lando3SpanIndex, path: Lando3Path): string | undefined =>
  index.identityNames.get(pathKey(path));

/** The recorded span for `path`, or the nearest recorded ancestor's span. */
export const lookupSpan = (index: Lando3SpanIndex, path: Lando3Path): LegacySourceSpan | undefined => {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const span = index.spans.get(pathKey(path.slice(0, depth)));
    if (span !== undefined) return span;
  }
  return index.root;
};
