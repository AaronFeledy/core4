/**
 * Structural redaction policy compiled from an Effect Schema AST.
 *
 * Redaction exists to keep user data out of output. A string a schema fixes to
 * a finite literal set (a discriminant, `apiVersion`, a stream name) cannot
 * carry user data, so masking it protects nothing and breaks schema decoding.
 * The same is true of a property name the schema declares. Everything else -
 * free text, template literals, unknown and dynamic keys - stays redacted.
 *
 * The policy is conservative: a value is exempt only when EVERY live schema
 * candidate at that position is a finite literal set that accepts it. A union
 * branch is dropped only when the value provably disagrees with it (JSON kind
 * mismatch, a present literal-only property outside its set, or a template
 * pattern it cannot match); an unknown, `String`, or opaque declaration
 * candidate keeps the position redacted. A position with no live candidate
 * redacts everything below it, exactly as schema-free redaction does today.
 *
 * Nodes are compiled lazily and memoized: narrowing reuses one discriminated
 * index per candidate set, and child/element nodes are cached by the identity of
 * the narrowed set (plus key or tuple slot), so repeated events through the same
 * schema position reuse compiled work.
 */

import {
  type Redactor,
  type ValueRedactionScope,
  isSecretFieldName,
  redactValueWith,
} from "@lando/sdk/secrets";
import { SchemaAST as AST, type Schema } from "effect";
import {
  type ObjectDiscriminatorIndex,
  type StructuralRedactionSide,
  acceptsKind,
  buildDiscriminatorIndex,
  finiteStringSet,
  normalizeCandidates,
} from "./structural-redaction-ast.ts";

export type { StructuralRedactionSide } from "./structural-redaction-ast.ts";

/** A schema-backed redaction scope; the narrowest policy is `undefined`. */
export interface StructuralRedactionNode extends ValueRedactionScope {
  readonly child: (key: string, value: object) => StructuralRedactionNode | undefined;
  readonly element: (index: number, length: number) => StructuralRedactionNode | undefined;
  /** True when every live candidate declares `key` as a property signature. */
  readonly keyIsDeclared: (key: string, value: object) => boolean;
}

export type StructuralRedactionInput = Schema.Top | AST.AST;

interface ChildEntry {
  readonly declared: boolean;
  readonly child: StructuralRedactionNode | undefined;
}

const compiled = new WeakMap<AST.AST, Map<StructuralRedactionSide, StructuralRedactionNode>>();

const indexAccepts = (parameter: unknown, key: string): boolean => {
  if (!AST.isAST(parameter)) return false;
  if (AST.isString(parameter)) return true;
  if (AST.isNumber(parameter)) return /^\d+$/u.test(key);
  if (AST.isUnion(parameter)) {
    for (const member of parameter.types) {
      if (indexAccepts(member, key)) return true;
    }
  }
  return false;
};

const indexTypes = (ast: AST.Objects, key: string): readonly AST.AST[] => {
  const types: AST.AST[] = [];
  for (const signature of ast.indexSignatures) {
    if (indexAccepts(signature.parameter, key)) types.push(signature.type);
  }
  return types;
};

/** Tuple fixed elements, then the spread type, then post-spread trailing elements. */
const arrayElement = (ast: AST.Arrays, index: number, length: number): AST.AST | undefined => {
  const element = ast.elements[index];
  if (element !== undefined) return element;
  const [spread, ...tail] = ast.rest;
  if (spread === undefined) return undefined;
  if (tail.length === 0) return spread;
  const tailStart = Math.max(ast.elements.length, length - tail.length);
  return index >= tailStart ? ast.rest[index - tailStart + 1] : spread;
};

/** A stable, small slot name for a tuple/array position; exact only when shapes overlap. */
const elementSlot = (live: readonly AST.AST[], index: number, length: number): string => {
  const slots: string[] = [];
  for (const candidate of live) {
    if (!AST.isArrays(candidate) || candidate.rest.length > 1) return `${index}/${length}`;
    if (index < candidate.elements.length) slots.push(`f${index}`);
    else if (candidate.rest.length === 1) slots.push("s");
    else return `${index}/${length}`;
  }
  return slots.join("|");
};

const resolveChild = (key: string, live: readonly AST.AST[], side: StructuralRedactionSide): ChildEntry => {
  if (live.length === 0) return { declared: false, child: undefined };
  const children: AST.AST[] = [];
  let declared = true;
  for (const candidate of live) {
    if (!AST.isObjects(candidate)) return { declared: false, child: undefined };
    const signature = candidate.propertySignatures.find((entry) => entry.name === key);
    if (signature !== undefined) {
      children.push(signature.type);
      continue;
    }
    declared = false;
    // A live member that neither declares nor indexes the key leaves it unconstrained
    // (an excess property), so no other member's literal may exempt it.
    const indexed = indexTypes(candidate, key);
    if (indexed.length === 0) return { declared, child: undefined };
    children.push(...indexed);
  }
  return { declared, child: children.length === 0 ? undefined : makeNode(children, side) };
};

const makeNode = (raw: readonly AST.AST[], side: StructuralRedactionSide): StructuralRedactionNode => {
  let normalized: readonly AST.AST[] | undefined;
  let objectCandidates: readonly AST.AST[] | undefined;
  let arrayCandidates: readonly AST.AST[] | undefined;
  let strings: ReadonlySet<string> | "opaque" | undefined;
  let objectIndex: ObjectDiscriminatorIndex | undefined;
  let byObject: WeakMap<object, readonly AST.AST[]> | undefined;
  let childNodes: WeakMap<readonly AST.AST[], Map<string, ChildEntry>> | undefined;
  let elementNodes: Map<string, StructuralRedactionNode | undefined> | undefined;

  const candidates = (): readonly AST.AST[] => {
    normalized ??= normalizeCandidates(raw, side);
    return normalized;
  };
  const objects = (): readonly AST.AST[] => {
    objectCandidates ??= candidates().filter((candidate) => acceptsKind(candidate, "object"));
    return objectCandidates;
  };
  const arrays = (): readonly AST.AST[] => {
    arrayCandidates ??= candidates().filter((candidate) => acceptsKind(candidate, "array"));
    return arrayCandidates;
  };
  const stringValues = (): ReadonlySet<string> | undefined => {
    if (strings === undefined) {
      const live = candidates().filter((candidate) => acceptsKind(candidate, "string"));
      const values = new Set<string>();
      let opaque = false;
      for (const candidate of live) {
        const set = finiteStringSet(candidate);
        if (set === undefined) {
          opaque = true;
          break;
        }
        for (const entry of set) values.add(entry);
      }
      strings = opaque ? "opaque" : values;
    }
    return strings === "opaque" ? undefined : strings;
  };
  const forObject = (value: object): readonly AST.AST[] => {
    const cached = byObject?.get(value);
    if (cached !== undefined) return cached;
    if (objectIndex === undefined) objectIndex = buildDiscriminatorIndex(objects(), side);
    const live = objectIndex.select(value);
    if (byObject === undefined) byObject = new WeakMap();
    byObject.set(value, live);
    return live;
  };
  const childEntry = (key: string, value: object): ChildEntry => {
    const live = forObject(value);
    let perKey = childNodes?.get(live);
    if (perKey === undefined) {
      perKey = new Map();
      if (childNodes === undefined) childNodes = new WeakMap();
      childNodes.set(live, perKey);
    }
    const cached = perKey.get(key);
    if (cached !== undefined) return cached;
    const entry = resolveChild(key, live, side);
    perKey.set(key, entry);
    return entry;
  };

  return {
    keyIsDeclared: (key, value) => childEntry(key, value).declared,
    child: (key, value) => childEntry(key, value).child,
    element: (index, length) => {
      const live = arrays();
      if (live.length === 0) return undefined;
      const slot = elementSlot(live, index, length);
      elementNodes ??= new Map();
      if (elementNodes.has(slot)) return elementNodes.get(slot);
      const children: AST.AST[] = [];
      for (const candidate of live) {
        if (!AST.isArrays(candidate)) {
          elementNodes.set(slot, undefined);
          return undefined;
        }
        const element = arrayElement(candidate, index, length);
        if (element === undefined) {
          elementNodes.set(slot, undefined);
          return undefined;
        }
        children.push(element);
      }
      const node = makeNode(children, side);
      elementNodes.set(slot, node);
      return node;
    },
    stringIsExempt: (value) => stringValues()?.has(value) === true,
  };
};

/**
 * Compile a schema into a memoized structural redaction policy. Compilation is
 * lazy and walks the AST alongside a value, so recursive schemas terminate on
 * their (finite) runtime data instead of expanding up front.
 */
export const structuralRedaction = (
  input: StructuralRedactionInput,
  side: StructuralRedactionSide = "encoded",
): StructuralRedactionNode => {
  const ast: AST.AST = AST.isAST(input) ? input : input.ast;
  let bySide = compiled.get(ast);
  if (bySide === undefined) {
    bySide = new Map();
    compiled.set(ast, bySide);
  }
  const cached = bySide.get(side);
  if (cached !== undefined) return cached;
  const node = makeNode([ast], side);
  bySide.set(side, node);
  return node;
};

/**
 * Redact a runtime value with the same structure-preserving, never-throwing
 * guarantees as `Redactor.redactValue`, keeping schema-fixed literals.
 */
export const redactValueWithPolicy = (
  redactor: Pick<Redactor, "redactString">,
  policy: StructuralRedactionNode | undefined,
  value: unknown,
): unknown => redactValueWith(redactor.redactString, isSecretFieldName, value, policy);
