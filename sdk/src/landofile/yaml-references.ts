import { LandofileParseError } from "../errors/index.ts";

export interface YamlReferenceLocation {
  readonly line: number;
  readonly column: number;
}

export type YamlReferenceSyntax =
  | { readonly kind: "plain" }
  | ({ readonly kind: "alias"; readonly name: string } & YamlReferenceLocation)
  | ({ readonly kind: "anchor"; readonly name: string; readonly value: string } & YamlReferenceLocation & {
        readonly valueColumn: number;
      });

const YAML_ALIAS = Symbol("YamlAlias");

interface YamlAlias extends YamlReferenceLocation {
  readonly [YAML_ALIAS]: true;
  readonly name: string;
}

interface AnchorDefinition extends YamlReferenceLocation {
  value: unknown | typeof UNBOUND;
}

interface MergeEntry extends YamlReferenceLocation {
  readonly value: unknown;
}

export interface YamlReferenceState {
  readonly filePath: string;
  readonly anchors: Map<string, AnchorDefinition>;
  readonly merges: WeakMap<Record<string, unknown>, MergeEntry[]>;
}

// YAML 1.2 anchor/alias names accept any non-space character except the flow
// indicators. The tag detector in parser.ts MUST reuse this exact pattern: when
// the two disagree, an anchored value is a reference to one and an opaque
// string to the other, which is how `&a.b !reset` escaped Compose rejection.
export const YAML_REFERENCE_NAME_PATTERN = /[^\s,[\]{}]+/;

const ALIAS_PATTERN = /^\*([^\s,[\]{}]+)$/;
const ANCHOR_PATTERN = /^&([^\s,[\]{}]+)(?:\s+(.*))?$/;

const UNBOUND = Symbol("YamlAnchorUnbound");
const REFERENCE_REMEDIATION =
  "Define each anchor once before use, avoid recursive aliases, and merge only mapping aliases.";
const EXPANSION_REMEDIATION =
  "Reduce how many times aliases re-expand anchors that themselves contain aliases.";
const MIN_EXPANSION_BUDGET = 50_000;

const referenceError = (
  state: YamlReferenceState,
  message: string,
  location: YamlReferenceLocation,
): LandofileParseError =>
  new LandofileParseError({
    message,
    filePath: state.filePath,
    line: location.line,
    column: location.column,
    remediation: REFERENCE_REMEDIATION,
  });

export const makeYamlReferenceState = (filePath: string): YamlReferenceState => ({
  filePath,
  anchors: new Map(),
  merges: new WeakMap(),
});

export const parseYamlReferenceSyntax = (
  value: string,
  location: YamlReferenceLocation,
): YamlReferenceSyntax => {
  const leadingWhitespace = value.search(/\S/);
  if (leadingWhitespace < 0) return { kind: "plain" };
  // Inline sequence entries reach here untrimmed (`[ *base ]`), so trailing
  // whitespace must not defeat the anchor/alias patterns below.
  const trimmed = value.slice(leadingWhitespace).trimEnd();
  const column = location.column + leadingWhitespace;

  const alias = trimmed.match(ALIAS_PATTERN);
  const aliasName = alias?.[1];
  if (aliasName !== undefined) return { kind: "alias", name: aliasName, line: location.line, column };

  const anchor = trimmed.match(ANCHOR_PATTERN);
  const anchorName = anchor?.[1];
  if (anchorName === undefined) return { kind: "plain" };
  const anchoredValue = anchor?.[2] ?? "";
  const valueOffset = trimmed.length - anchoredValue.length;
  return {
    kind: "anchor",
    name: anchorName,
    value: anchoredValue,
    line: location.line,
    column,
    valueColumn: column + valueOffset,
  };
};

export const reserveYamlAnchor = (
  state: YamlReferenceState,
  anchor: Extract<YamlReferenceSyntax, { readonly kind: "anchor" }>,
): void => {
  if (state.anchors.has(anchor.name)) {
    throw referenceError(state, `Duplicate YAML anchor &${anchor.name}.`, anchor);
  }
  state.anchors.set(anchor.name, { value: UNBOUND, line: anchor.line, column: anchor.column });
};

export const bindYamlAnchor = (state: YamlReferenceState, name: string, value: unknown): void => {
  const anchor = state.anchors.get(name);
  if (anchor !== undefined) anchor.value = value;
};

export const makeYamlAlias = (
  alias: Extract<YamlReferenceSyntax, { readonly kind: "alias" }>,
): YamlAlias => ({ [YAML_ALIAS]: true, name: alias.name, line: alias.line, column: alias.column });

export const registerYamlMerge = (
  state: YamlReferenceState,
  target: Record<string, unknown>,
  value: unknown,
  location: YamlReferenceLocation,
): void => {
  const entries = state.merges.get(target) ?? [];
  entries.push({ value, line: location.line, column: location.column });
  state.merges.set(target, entries);
};

const isYamlAlias = (value: unknown): value is YamlAlias =>
  typeof value === "object" &&
  value !== null &&
  YAML_ALIAS in value &&
  value[YAML_ALIAS] === true &&
  "name" in value &&
  typeof value.name === "string" &&
  "line" in value &&
  typeof value.line === "number" &&
  "column" in value &&
  typeof value.column === "number";

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isYamlAlias(value);

/**
 * Resolves anchors, aliases, and merge keys into a plain value tree.
 *
 * `sourceLength` bounds alias expansion: nested aliases multiply, so a few
 * hundred bytes of YAML can otherwise expand to gigabytes. A document with no
 * aliases can never emit more nodes than it has bytes, so a budget of at least
 * the source length never rejects an alias-free document.
 */
export const resolveYamlReferences = (
  state: YamlReferenceState,
  root: unknown,
  sourceLength: number,
  maxDepth: number,
): unknown => {
  const maxNodes = Math.max(MIN_EXPANSION_BUDGET, sourceLength);
  let remaining = maxNodes;

  const resolve = (value: unknown, stack: ReadonlyArray<string>, origin: YamlReferenceLocation): unknown => {
    remaining -= 1;
    if (remaining < 0) {
      throw new LandofileParseError({
        message: `Resolving YAML aliases exceeded the maximum of ${maxNodes} expanded nodes.`,
        filePath: state.filePath,
        line: origin.line,
        column: origin.column,
        remediation: EXPANSION_REMEDIATION,
      });
    }

    if (isYamlAlias(value)) {
      if (stack.length >= maxDepth) {
        throw referenceError(state, `YAML alias graph exceeded the maximum depth of ${maxDepth}.`, value);
      }
      const anchor = state.anchors.get(value.name);
      if (
        anchor === undefined ||
        anchor.line > value.line ||
        (anchor.line === value.line && anchor.column > value.column)
      ) {
        throw referenceError(state, `Unknown YAML alias *${value.name}.`, value);
      }
      if (anchor.value === UNBOUND || stack.includes(value.name)) {
        throw referenceError(state, `Detected a recursive YAML alias graph through *${value.name}.`, value);
      }
      return resolve(anchor.value, [...stack, value.name], value);
    }
    if (Array.isArray(value)) return value.map((entry) => resolve(entry, stack, origin));
    if (!isMapping(value)) return value;

    const resolvedEntries = new Map<string, unknown>();
    for (const merge of state.merges.get(value) ?? []) {
      const targets = Array.isArray(merge.value) ? merge.value : [merge.value];
      for (const target of targets) {
        const resolved = resolve(target, stack, origin);
        for (const mapping of Array.isArray(resolved) ? resolved : [resolved]) {
          if (!isMapping(mapping)) {
            throw referenceError(
              state,
              "YAML merge target must be a mapping or a sequence of mappings.",
              isYamlAlias(target) ? target : merge,
            );
          }
          for (const [key, entry] of Object.entries(mapping)) {
            if (!resolvedEntries.has(key)) resolvedEntries.set(key, entry);
          }
        }
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      resolvedEntries.set(key, resolve(entry, stack, origin));
    }
    return Object.fromEntries(resolvedEntries);
  };

  return resolve(root, [], { line: 1, column: 1 });
};
