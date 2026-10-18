/**
 * Remediation text for rejected YAML flow mappings (`{k: v, ...}`).
 *
 * Simple single-level maps with scalar entries get a concrete block
 * rewrite. Nested braces/brackets, quoted separators, or
 * otherwise unparseable forms keep a generic block-mapping suggestion.
 *
 * Pure and Effect-free so cold-path recipe parsing can reuse it without the
 * Landofile parser graph.
 */

/** Generic suggestion when a concrete block rewrite would be unsafe. */
export const GENERIC_FLOW_MAPPING_REMEDIATION =
  "Rewrite the flow mapping as an indented block mapping; use a block sequence for mapping items.";

const SIMPLE_KEY = /^[A-Za-z0-9_.@/-]+$/;

export interface FlowMappingRemediationOptions {
  /** Mapping key that owns the flow value, when known (e.g. `healthcheck`). */
  readonly parentKey?: string;
}

/**
 * Try to read `{k: v, k2: v2}` as simple scalar pairs.
 * Returns undefined when the form is nested or separators are ambiguous.
 */
const trySimpleFlowPairs = (
  flowText: string,
): ReadonlyArray<{ readonly key: string; readonly value: string }> | undefined => {
  const trimmed = flowText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return undefined;

  if (/[{}\[\]]/.test(inner)) return undefined;

  const pairs: { key: string; value: string }[] = [];
  for (const part of inner.split(",")) {
    const entry = part.trim();
    if (entry === "") return undefined;
    const colon = entry.indexOf(":");
    if (colon <= 0) return undefined;
    const key = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (key === "" || value === "" || !SIMPLE_KEY.test(key)) return undefined;
    if (/["']/.test(value) && !/^(?:"[^",:]*"|'[^',:]*')$/.test(value)) return undefined;
    // A second unquoted mapping-style "k: v" inside the value is not single-level.
    // Port-style scalars such as `8080:80` stay one token (no space after ':').
    if (/(?:^|\s)[A-Za-z0-9_.@/-]+\s*:\s+\S/.test(value)) return undefined;
    pairs.push({ key, value });
  }
  return pairs.length > 0 ? pairs : undefined;
};

/**
 * Build remediation for a rejected flow mapping body (including braces).
 */
export const flowMappingRemediation = (
  flowText: string,
  options: FlowMappingRemediationOptions = {},
): string => {
  const pairs = trySimpleFlowPairs(flowText);
  if (pairs === undefined) return GENERIC_FLOW_MAPPING_REMEDIATION;

  const lines: string[] = ["Rewrite the flow mapping as a block mapping:"];
  const parentKey = options.parentKey?.trim();
  let indent = "";
  if (parentKey !== undefined && parentKey !== "") {
    lines.push(`${parentKey}:`);
    indent = "  ";
  }
  for (const { key, value } of pairs) {
    lines.push(`${indent}${key}: ${value}`);
  }
  return lines.join("\n");
};
