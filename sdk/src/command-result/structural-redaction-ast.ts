/**
 * AST primitives for the structural redaction policy.
 *
 * These helpers answer one conservative question at a time: what does a
 * normalized candidate set accept at this position, and can a value be proven
 * to disagree with a union member? They never promote ambiguity into an
 * exemption. Object narrowing uses a per-node discriminator index so a large
 * union reads one sentinel property and selects its agreeing members instead of
 * testing every member.
 */

import { SchemaAST as AST } from "effect";

/** Which side of a codec a policy describes: wire values or runtime values. */
export type StructuralRedactionSide = "encoded" | "type";

export type LiteralPrimitive = string | number | boolean;

export type Discriminator =
  | { readonly kind: "literals"; readonly key: PropertyKey; readonly values: ReadonlySet<LiteralPrimitive> }
  | { readonly kind: "pattern"; readonly key: PropertyKey; readonly pattern: RegExp };

export type ObjectDiscriminatorIndex = { readonly select: (value: object) => readonly AST.AST[] };

type PropertyRead = { readonly present: boolean; readonly value?: unknown };

const EMPTY: ReadonlySet<string> = new Set();

const MAX_NORMALIZE_STEPS = 1024;

export const finiteStringSet = (ast: AST.AST): ReadonlySet<string> | undefined => {
  if (AST.isLiteral(ast)) return typeof ast.literal === "string" ? new Set([ast.literal]) : EMPTY;
  if (AST.isEnum(ast))
    return new Set(ast.enums.flatMap(([, value]) => (typeof value === "string" ? [value] : [])));
  return undefined;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const templateSource = (ast: AST.TemplateLiteral, depth: number): string | undefined => {
  if (depth > 8) return undefined;
  let source = "";
  for (const part of ast.parts) {
    if (AST.isTemplateLiteral(part)) {
      const nested = templateSource(part, depth + 1);
      if (nested === undefined) return undefined;
      source += nested;
    } else if (AST.isLiteral(part)) {
      const literal = part.literal;
      if (typeof literal !== "string" && typeof literal !== "number") return undefined;
      source += escapeRegExp(String(literal));
    } else if (AST.isString(part)) source += "[\\s\\S]*";
    else return undefined;
  }
  return source;
};

const templatePattern = (ast: AST.TemplateLiteral): RegExp | undefined => {
  const source = templateSource(ast, 0);
  return source === undefined ? undefined : new RegExp(`^${source}$`, "u");
};

export const normalizeCandidates = (
  input: readonly AST.AST[],
  side: StructuralRedactionSide,
): readonly AST.AST[] => {
  const output: AST.AST[] = [];
  const seen = new Set<AST.AST>();
  const pending = [...input];
  while (pending.length > 0 && seen.size <= MAX_NORMALIZE_STEPS) {
    const ast = pending.pop();
    if (ast === undefined || seen.has(ast)) continue;
    seen.add(ast);
    if (AST.isNever(ast)) continue;
    if (AST.isSuspend(ast)) {
      pending.push(ast.thunk());
      continue;
    }
    if (AST.isUnion(ast)) {
      pending.push(...ast.types);
      continue;
    }
    if (ast.encoding !== undefined) {
      pending.push(side === "encoded" ? AST.toEncoded(ast) : AST.toType(ast));
      continue;
    }
    output.push(ast);
  }
  // An exhausted budget leaves members unread; an unknown candidate keeps the position opaque.
  if (pending.length > 0) output.push(AST.unknown);
  return output;
};

const discriminatorFor = (
  signature: AST.PropertySignature,
  side: StructuralRedactionSide,
): Discriminator | undefined => {
  const candidates = normalizeCandidates([signature.type], side);
  if (candidates.length === 0) return undefined;
  const values = new Set<LiteralPrimitive>();
  for (const candidate of candidates) {
    if (AST.isLiteral(candidate)) {
      const literal = candidate.literal;
      if (typeof literal !== "string" && typeof literal !== "number" && typeof literal !== "boolean")
        return undefined;
      values.add(literal);
      continue;
    }
    if (AST.isEnum(candidate)) {
      for (const [, value] of candidate.enums) values.add(value);
      continue;
    }
    if (candidates.length === 1 && AST.isTemplateLiteral(candidate)) {
      const pattern = templatePattern(candidate);
      return pattern === undefined ? undefined : { kind: "pattern", key: signature.name, pattern };
    }
    return undefined;
  }
  return { kind: "literals", key: signature.name, values };
};

const discriminatorCache = new WeakMap<AST.AST, Map<StructuralRedactionSide, readonly Discriminator[]>>();

const discriminatorsFor = (ast: AST.AST, side: StructuralRedactionSide): readonly Discriminator[] => {
  if (!AST.isObjects(ast)) return [];
  let bySide = discriminatorCache.get(ast);
  if (bySide === undefined) {
    bySide = new Map();
    discriminatorCache.set(ast, bySide);
  }
  const cached = bySide.get(side);
  if (cached !== undefined) return cached;
  const result = ast.propertySignatures.flatMap((signature) => {
    const discriminator = discriminatorFor(signature, side);
    return discriminator === undefined ? [] : [discriminator];
  });
  bySide.set(side, result);
  return result;
};

const readProperty = (value: object, key: PropertyKey): PropertyRead => {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    descriptor = undefined;
  }
  return descriptor !== undefined && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false };
};

const rejects = (discriminator: Discriminator, read: PropertyRead): boolean => {
  if (!read.present) return false;
  const current = read.value;
  if (discriminator.kind === "literals") {
    if (current === null || typeof current === "object") return false;
    return !discriminator.values.has(current as LiteralPrimitive);
  }
  return typeof current === "string" && !discriminator.pattern.test(current);
};

/**
 * Build a one-sentinel discriminator index for a candidate set. The sentinel is
 * the discriminator key the most candidates share; candidates without it stay
 * live, and every cohort is re-checked against its remaining discriminators, so
 * the result is identical to testing every candidate directly.
 */
export const buildDiscriminatorIndex = (
  candidates: readonly AST.AST[],
  side: StructuralRedactionSide,
): ObjectDiscriminatorIndex => {
  const coverage = new Map<PropertyKey, number>();
  for (const candidate of candidates)
    for (const discriminator of discriminatorsFor(candidate, side))
      coverage.set(discriminator.key, (coverage.get(discriminator.key) ?? 0) + 1);
  const sentinelKey = [...coverage].sort((left, right) => right[1] - left[1])[0]?.[0];

  const base: AST.AST[] = [];
  const literals = new Map<LiteralPrimitive, AST.AST[]>();
  const patterns: Array<{ readonly pattern: RegExp; readonly candidate: AST.AST }> = [];
  if (sentinelKey !== undefined) {
    for (const candidate of candidates) {
      const discriminator = discriminatorsFor(candidate, side).find((entry) => entry.key === sentinelKey);
      if (discriminator === undefined) base.push(candidate);
      else if (discriminator.kind === "pattern") patterns.push({ pattern: discriminator.pattern, candidate });
      else
        for (const literal of discriminator.values) {
          const bucket = literals.get(literal);
          if (bucket === undefined) literals.set(literal, [candidate]);
          else bucket.push(candidate);
        }
    }
  }

  // Buckets group candidates by discriminator value; keep candidate order so a
  // cohort matches what an in-order scan of every candidate would keep.
  const cohortOf = (parts: readonly (readonly AST.AST[])[]): readonly AST.AST[] => {
    const members = new Set(parts.flat());
    return candidates.filter((candidate) => members.has(candidate));
  };

  const filter = (cohort: readonly AST.AST[], value: object, skip: PropertyKey | undefined) => {
    const reads = new Map<PropertyKey, PropertyRead>();
    const read = (key: PropertyKey): PropertyRead => {
      let cached = reads.get(key);
      if (cached === undefined) {
        cached = readProperty(value, key);
        reads.set(key, cached);
      }
      return cached;
    };
    let kept: AST.AST[] | undefined;
    for (let index = 0; index < cohort.length; index += 1) {
      const candidate = cohort[index];
      const accepted =
        candidate !== undefined &&
        discriminatorsFor(candidate, side).every(
          (discriminator) => discriminator.key === skip || !rejects(discriminator, read(discriminator.key)),
        );
      if (accepted) {
        kept?.push(candidate);
        continue;
      }
      kept ??= cohort.slice(0, index);
    }
    return kept ?? cohort;
  };

  const patternMatches = (current: unknown): readonly AST.AST[] =>
    typeof current === "string"
      ? patterns.filter((entry) => entry.pattern.test(current)).map((entry) => entry.candidate)
      : patterns.map((entry) => entry.candidate);

  const combined = new Map<LiteralPrimitive, readonly AST.AST[]>();

  const select = (value: object): readonly AST.AST[] => {
    if (sentinelKey === undefined) return filter(candidates, value, undefined);
    const read = readProperty(value, sentinelKey);
    const current = read.value;
    if (!read.present || current === null || typeof current === "object")
      return filter(candidates, value, undefined);
    const key = current as LiteralPrimitive;
    const literal = literals.get(key);
    if (literal === undefined) return filter(cohortOf([base, patternMatches(current)]), value, sentinelKey);
    let cohort = combined.get(key);
    if (cohort === undefined) {
      cohort = cohortOf([base, literal, patternMatches(current)]);
      combined.set(key, cohort);
    }
    return filter(cohort, value, sentinelKey);
  };

  return { select };
};

const KIND_BY_TAG: Readonly<Record<string, string>> = {
  String: "string",
  TemplateLiteral: "string",
  Number: "number",
  Boolean: "boolean",
  BigInt: "bigint",
  Symbol: "symbol",
  UniqueSymbol: "symbol",
  Null: "null",
  Void: "undefined",
  Undefined: "undefined",
  Arrays: "array",
};

export const acceptsKind = (ast: AST.AST, kind: string): boolean => {
  if (ast._tag === "Literal") return (ast.literal === null ? "null" : typeof ast.literal) === kind;
  if (ast._tag === "Enum") return ast.enums.some(([, value]) => typeof value === kind);
  if (ast._tag === "Objects")
    return kind === "object" || (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0);
  return KIND_BY_TAG[ast._tag] === undefined || KIND_BY_TAG[ast._tag] === kind;
};
