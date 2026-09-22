import {
  type LegacyNode,
  type LegacyTagOccurrence,
  type LegacyTree,
  isLegacyTagged,
  makeLegacyTagged,
} from "./contract.ts";
import { legacyParseError } from "./errors.ts";
import { type ResolvedLegacyLimits, expansionBudget } from "./limits.ts";
import { resolvePlainScalar } from "./scalars.ts";

const REFERENCE_REMEDIATION =
  "Define each anchor once before use, avoid recursive aliases, and merge only mapping aliases.";

export const projectLegacyTree = (input: {
  readonly tree: LegacyTree;
  readonly file: string;
  readonly limits: ResolvedLegacyLimits;
  readonly sourceLength: number;
}): { readonly value: unknown; readonly tags: ReadonlyArray<LegacyTagOccurrence> } => {
  const { tree, file, limits, sourceLength } = input;
  const tags: LegacyTagOccurrence[] = [];
  const maxNodes = expansionBudget(sourceLength);
  let remaining = maxNodes;
  if (tree.aliasCount > limits.maxAliases) {
    throw legacyParseError(
      file,
      `YAML alias count exceeded the maximum: ${tree.aliasCount} aliases > ${limits.maxAliases}.`,
      tree.root?.span.start,
      "Reduce the number of aliases or raise the configured maximum alias count.",
    );
  }

  const resolve = (
    node: LegacyNode,
    stack: ReadonlyArray<string>,
    path: ReadonlyArray<string | number>,
  ): unknown => {
    remaining -= 1;
    if (remaining < 0) {
      throw legacyParseError(
        file,
        `Resolving YAML aliases exceeded the maximum of ${maxNodes} expanded nodes.`,
        node.span.start,
        "Reduce how many times aliases re-expand anchors that themselves contain aliases.",
      );
    }
    // Inventory source occurrences, not the copies produced by alias expansion.
    if ("tag" in node && node.tag !== undefined && stack.length === 0) {
      tags.push({ tag: node.tag, span: node.span, path });
    }
    let value: unknown;
    switch (node.kind) {
      case "alias": {
        if (stack.includes(node.name)) {
          throw legacyParseError(
            file,
            `Detected a recursive YAML alias graph through *${node.name}.`,
            node.span.start,
            REFERENCE_REMEDIATION,
          );
        }
        if (stack.length >= limits.maxDepth) {
          throw legacyParseError(
            file,
            `YAML alias graph exceeded the maximum depth of ${limits.maxDepth}.`,
            node.span.start,
            REFERENCE_REMEDIATION,
          );
        }
        const target = tree.anchors.get(node.name);
        if (target === undefined) {
          throw legacyParseError(
            file,
            `Unknown YAML alias *${node.name}.`,
            node.span.start,
            REFERENCE_REMEDIATION,
          );
        }
        return resolve(target, [...stack, node.name], path);
      }
      case "scalar":
        value = node.style === "plain" ? resolvePlainScalar(node.text) : node.text;
        break;
      case "sequence":
        value = node.items.map((item, index) => resolve(item, stack, [...path, index]));
        break;
      case "mapping": {
        const merged = new Map<string, unknown>();
        const explicit = new Map<string, unknown>();
        for (const entry of node.entries) {
          const key = entry.key.text;
          const entryPath = [...path, key];
          if (entry.key.tag !== undefined && stack.length === 0) {
            tags.push({ tag: entry.key.tag, span: entry.key.span, path: entryPath });
          }
          const resolved = resolve(entry.value, stack, entryPath);
          if (key !== "<<") {
            explicit.set(key, resolved);
            continue;
          }
          const targets: ReadonlyArray<unknown> = Array.isArray(resolved) ? resolved : [resolved];
          for (const target of targets) {
            if (
              typeof target !== "object" ||
              target === null ||
              Array.isArray(target) ||
              isLegacyTagged(target)
            ) {
              throw legacyParseError(
                file,
                "YAML merge target must be a mapping or a sequence of mappings.",
                entry.value.span.start,
                REFERENCE_REMEDIATION,
              );
            }
            for (const [name, member] of Object.entries(target)) {
              if (!merged.has(name)) merged.set(name, member);
            }
          }
        }
        // fromEntries keeps __proto__ an own property rather than invoking a setter.
        value = Object.fromEntries([...merged, ...explicit]);
        break;
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
    return node.tag === undefined ? value : makeLegacyTagged(node.tag, value, node.span);
  };

  // Empty documents use undefined, distinct from an explicit YAML null scalar.
  return { value: tree.root === null ? undefined : resolve(tree.root, [], []), tags };
};
