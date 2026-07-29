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

interface YamlAlias extends YamlReferenceLocation {
  readonly _tag: "YamlAlias";
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

const UNBOUND = Symbol("YamlAnchorUnbound");
const REFERENCE_REMEDIATION =
  "Define each anchor once before use, avoid recursive aliases, and merge only mapping aliases.";

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
  const trimmed = value.slice(leadingWhitespace);
  const column = location.column + leadingWhitespace;

  const alias = trimmed.match(/^\*([A-Za-z0-9_-]+)$/);
  const aliasName = alias?.[1];
  if (aliasName !== undefined) return { kind: "alias", name: aliasName, line: location.line, column };

  const anchor = trimmed.match(/^&([A-Za-z0-9_-]+)(?:\s+(.*))?$/);
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
): YamlAlias => ({ _tag: "YamlAlias", name: alias.name, line: alias.line, column: alias.column });

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
  "_tag" in value &&
  value._tag === "YamlAlias" &&
  "name" in value &&
  typeof value.name === "string" &&
  "line" in value &&
  typeof value.line === "number" &&
  "column" in value &&
  typeof value.column === "number";

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isYamlAlias(value);

export const resolveYamlReferences = (state: YamlReferenceState, root: unknown): unknown => {
  const resolve = (value: unknown, stack: ReadonlyArray<string>): unknown => {
    if (isYamlAlias(value)) {
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
      return resolve(anchor.value, [...stack, value.name]);
    }
    if (Array.isArray(value)) return value.map((entry) => resolve(entry, stack));
    if (!isMapping(value)) return value;

    const resolvedEntries = new Map<string, unknown>();
    for (const merge of state.merges.get(value) ?? []) {
      const targets = Array.isArray(merge.value) ? merge.value : [merge.value];
      for (const target of targets) {
        const mapping = resolve(target, stack);
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
    for (const [key, entry] of Object.entries(value)) {
      resolvedEntries.set(key, resolve(entry, stack));
    }
    return Object.fromEntries(resolvedEntries);
  };

  return resolve(root, []);
};
