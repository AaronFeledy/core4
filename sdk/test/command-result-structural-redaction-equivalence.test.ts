// Seeded equivalence checks for the schema-compiled structural redaction policy.
// allow: SIZE_OK — Two seeded property fixtures; the body is declarative schema and
// discriminator tables rather than branching logic.
//
// Property one: the one-sentinel discriminator index must select exactly the
// candidates an independent in-order filter keeps, for both the encoded and the
// runtime side of a codec.
// Property two: a long-lived policy, warmed by values from many union members in
// random order, must redact every value exactly like a fresh policy compiled
// from a structurally identical schema whose ASTs never hit the WeakMap cache.
import { describe, expect, test } from "bun:test";
import {
  type StructuralRedactionSide,
  redactValueWithPolicy,
  structuralRedaction,
} from "@lando/sdk/command-result";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";
import { SchemaAST as AST, Schema, SchemaTransformation } from "effect";
import { buildDiscriminatorIndex } from "../src/command-result/structural-redaction-ast.ts";

type Random = () => number;
type LiteralPrimitive = string | number | boolean;

const SEED = 0x5eed_1e55;
const INDEX_ITERATIONS = 400;
const CACHE_ITERATIONS = 200;
const SIDES: readonly StructuralRedactionSide[] = ["encoded", "type"];

const mulberry32 = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Pick from a list that is known to be non-empty, including lists holding `undefined`. */
const choose = <A>(random: Random, items: readonly [A, ...A[]]): A =>
  items[Math.floor(random() * items.length)] ?? items[0];

const describeValue = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? `${entry}n` : typeof entry === "symbol" ? String(entry) : entry,
  ) ?? "undefined";

// ==== property one: discriminator index equivalence ====

/** One property value a candidate can prove disagreeable; `accepts` is that proof. */
interface DiscriminatorSpec {
  readonly key: string;
  readonly literals: readonly LiteralPrimitive[];
  readonly accepts: (value: unknown) => boolean;
}
type CandidateSpecs = readonly (readonly DiscriminatorSpec[])[];
interface SideInputs {
  readonly candidates: readonly AST.AST[];
  readonly specs: CandidateSpecs;
}
interface CandidateCase {
  readonly name: string;
  readonly inputs: Readonly<Record<StructuralRedactionSide, SideInputs>>;
}

const literals = (key: string, values: readonly LiteralPrimitive[]): DiscriminatorSpec => ({
  key,
  literals: values,
  accepts: (value) => {
    if (value === null || typeof value === "object") return true;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      return values.includes(value);
    return false;
  },
});
const pattern = (key: string, source: string): DiscriminatorSpec => {
  const expression = new RegExp(source, "u");
  return { key, literals: [], accepts: (value) => typeof value !== "string" || expression.test(value) };
};
const bothSides = (candidates: readonly AST.AST[], specs: CandidateSpecs) => ({
  encoded: { candidates, specs },
  type: { candidates, specs },
});
const structs = (...schemas: readonly Schema.Top[]): readonly AST.AST[] =>
  schemas.map((schema) => schema.ast);

const tagCase: CandidateCase = {
  name: "tag union",
  inputs: bothSides(
    structs(
      Schema.Struct({
        _tag: Schema.Literal("task.detail"),
        taskId: Schema.String,
        stream: Schema.Literals(["stdout", "stderr"]),
      }),
      Schema.Struct({ _tag: Schema.Literals(["task.complete", "task.failed"]), taskId: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal("app.start"), appId: Schema.String }),
      Schema.Struct({ item: Schema.String }),
    ),
    [
      [literals("_tag", ["task.detail"]), literals("stream", ["stdout", "stderr"])],
      [literals("_tag", ["task.complete", "task.failed"])],
      [literals("_tag", ["app.start"])],
      [],
    ],
  ),
};

const scalarCase: CandidateCase = {
  name: "scalar union with a coverage tie",
  inputs: bothSides(
    structs(
      Schema.Struct({ kind: Schema.Literal(1), mode: Schema.Literals([true, false]) }),
      Schema.Struct({ kind: Schema.Literal(2), mode: Schema.Literal(false) }),
      Schema.Struct({ kind: Schema.Literal("text"), mode: Schema.Literal(true) }),
      Schema.Struct({ other: Schema.Number }),
    ),
    [
      [literals("kind", [1]), literals("mode", [true, false])],
      [literals("kind", [2]), literals("mode", [false])],
      [literals("kind", ["text"]), literals("mode", [true])],
      [],
    ],
  ),
};

const patternCase: CandidateCase = {
  name: "pattern union",
  inputs: bothSides(
    structs(
      Schema.Struct({ _tag: Schema.TemplateLiteral(["event.", Schema.String]) }),
      Schema.Struct({ _tag: Schema.TemplateLiteral(["log.", Schema.String]) }),
      Schema.Struct({ _tag: Schema.Literal("event.boot") }),
      Schema.Struct({ note: Schema.String }),
    ),
    [
      [pattern("_tag", "^event\\.[\\s\\S]*$")],
      [pattern("_tag", "^log\\.[\\s\\S]*$")],
      [literals("_tag", ["event.boot"])],
      [],
    ],
  ),
};

/** A member whose discriminator reads a string on the encoded side and a number on the runtime side. */
const transformMember = (wire: string, decoded: number) => {
  const encoded = Schema.Struct({ kind: Schema.Literal(wire), label: Schema.String });
  const value = Schema.Struct({ kind: Schema.Literal(decoded), label: Schema.String });
  const codec = encoded.pipe(
    Schema.decodeTo(
      value,
      SchemaTransformation.transform({
        decode: (input: { readonly kind: string; readonly label: string }) => ({
          kind: decoded,
          label: input.label,
        }),
        encode: (input: { readonly kind: number; readonly label: string }) => ({
          kind: wire,
          label: input.label,
        }),
      }),
    ),
  );
  return codec.ast;
};

const transformedCase: CandidateCase = (() => {
  const codecs = [transformMember("wire-a", 11), transformMember("wire-z", 12)];
  return {
    name: "transformed union",
    inputs: {
      encoded: {
        candidates: codecs.map((codec) => AST.toEncoded(codec)),
        specs: [[literals("kind", ["wire-a"])], [literals("kind", ["wire-z"])]],
      },
      type: {
        candidates: codecs.map((codec) => AST.toType(codec)),
        specs: [[literals("kind", [11])], [literals("kind", [12])]],
      },
    },
  };
})();

const CASES: readonly CandidateCase[] = [tagCase, scalarCase, patternCase, transformedCase];

const JUNK: readonly unknown[] = [
  "",
  "mystery",
  "task.detail-extra",
  "event.",
  0,
  -3,
  2.5,
  true,
  null,
  undefined,
  1n,
  Symbol.for("sentinel"),
  ["task.detail"],
  { nested: "task.detail" },
];

/** A value a schema position never fixes: wrong literal, wrong kind, or structurally odd. */
const junk = (random: Random): unknown => JUNK[Math.floor(random() * JUNK.length)];

const specKeys = (specs: CandidateSpecs): readonly string[] => [
  ...new Set(specs.flat().map((spec) => spec.key)),
];
const literalPool = (specs: CandidateSpecs): readonly LiteralPrimitive[] => [
  ...new Set(specs.flat().flatMap((spec) => spec.literals)),
];

/** Random object shape: right and wrong literals, missing, inherited, accessor and exotic values. */
const buildValue = (random: Random, specs: CandidateSpecs): object => {
  const pool = literalPool(specs);
  const inherited: Record<string, unknown> = {};
  const value: Record<string, unknown> = Object.create(inherited);
  for (const key of [...specKeys(specs), "extra"]) {
    if (random() < 0.18) continue;
    const literal = pool.length > 0 ? pool[Math.floor(random() * pool.length)] : undefined;
    const chosen: unknown = literal !== undefined && random() < 0.6 ? literal : junk(random);
    const placement = random();
    if (placement < 0.05) inherited[key] = chosen;
    else if (placement < 0.1)
      Object.defineProperty(value, key, { enumerable: true, configurable: true, get: () => chosen });
    else value[key] = chosen;
  }
  if (random() < 0.1) value[`dynamic-${Math.floor(random() * 4)}`] = junk(random);
  return value;
};

const readOwnProperty = (
  value: object,
  key: string,
): { readonly present: boolean; readonly value?: unknown } => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false };
};

/** The documented exclusion rule: only provable disagreement removes a candidate. */
const disagrees = (spec: DiscriminatorSpec, value: object): boolean => {
  const read = readOwnProperty(value, spec.key);
  return read.present && !spec.accepts(read.value);
};

const independentLive = (
  candidates: readonly AST.AST[],
  specs: CandidateSpecs,
  value: object,
): readonly AST.AST[] =>
  candidates.filter((_candidate, index) => (specs[index] ?? []).every((spec) => !disagrees(spec, value)));

describe("discriminator index equivalence", () => {
  for (const candidateCase of CASES) {
    for (const side of SIDES) {
      test(`${candidateCase.name} (${side}) selects exactly the independently surviving candidates`, () => {
        const { candidates, specs } = candidateCase.inputs[side];
        const index = buildDiscriminatorIndex(candidates, side);
        const random = mulberry32(SEED);
        for (let iteration = 0; iteration < INDEX_ITERATIONS; iteration += 1) {
          const value = buildValue(random, specs);
          const actual = index.select(value).map((candidate) => candidates.indexOf(candidate));
          const expected = independentLive(candidates, specs, value).map((candidate) =>
            candidates.indexOf(candidate),
          );
          if (actual.join(",") === expected.join(",")) continue;
          throw new Error(
            `discriminator index disagrees with independent filtering\ncase: ${candidateCase.name} (${side})\n` +
              `seed: ${SEED} iteration: ${iteration}\nvalue: ${describeValue(value)}\n` +
              `actual: [${actual.join(", ")}]\nexpected: [${expected.join(", ")}]`,
          );
        }
      });
    }
  }
});

// ==== property two: policy cache equivalence ====

const CACHED_SECRETS = [
  "task.detail",
  "task.complete",
  "stdout",
  "stderr",
  "ok",
  "warn",
  "alpha-only",
  "beta-only",
  "collection",
  "head",
  "first",
  "line-text",
  "summary-text",
  "field-value",
] as const;

/** A fresh structurally identical schema: new ASTs, so the policy WeakMap always misses. */
const makeCachedSchema = (): Schema.Top => {
  const Item = Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("item.alpha"), value: Schema.Literals(["alpha-only"]) }),
    Schema.Struct({ _tag: Schema.Literal("item.beta"), value: Schema.Literals(["beta-only"]) }),
    Schema.Struct({ _tag: Schema.Literal("item.text"), text: Schema.String }),
  ]);
  return Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("task.detail"),
      taskId: Schema.String,
      stream: Schema.Literals(["stdout", "stderr"]),
      line: Schema.String,
      secretKey: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      _tag: Schema.Literal("task.complete"),
      taskId: Schema.String,
      summary: Schema.String,
      outcome: Schema.Literals(["ok", "warn"]),
    }),
    Schema.Struct({ _tag: Schema.Literal("item.alpha"), value: Schema.Literals(["alpha-only"]) }),
    Schema.Struct({ _tag: Schema.Literal("item.beta"), value: Schema.Literals(["beta-only"]) }),
    Schema.Struct({
      _tag: Schema.Literal("collection"),
      items: Schema.Array(Item),
      labels: Schema.Record(Schema.String, Schema.String),
      note: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      _tag: Schema.Literal("tuple"),
      pair: Schema.Tuple([Schema.Literal("head"), Schema.String]),
      rest: Schema.TupleWithRest(Schema.Tuple([Schema.Literal("first")]), [Schema.String]),
    }),
  ]);
};

const FREE_TEXT = ["line-text", "summary-text", "plain text", "field-value"] as const;
const LABEL_KEYS = ["line-text", "dynamic-key", "summary-text"] as const;

const randomCachedValue = (random: Random): unknown => {
  const item = (): unknown =>
    choose(random, [
      { _tag: "item.alpha", value: "alpha-only" },
      { _tag: "item.beta", value: "beta-only" },
      { _tag: "item.text", text: choose(random, FREE_TEXT) },
    ]);
  const labels = (): Record<string, string> => {
    const record: Record<string, string> = {};
    for (let count = Math.floor(random() * 3); count > 0; count -= 1)
      record[choose(random, LABEL_KEYS)] = choose(random, FREE_TEXT);
    return record;
  };
  switch (Math.floor(random() * 6)) {
    case 0:
      return {
        _tag: "task.detail",
        taskId: choose(random, FREE_TEXT),
        stream: choose(random, ["stdout", "stderr"]),
        line: choose(random, FREE_TEXT),
        ...(random() < 0.4 ? { secretKey: choose(random, FREE_TEXT) } : {}),
      };
    case 1:
      return {
        _tag: "task.complete",
        taskId: choose(random, FREE_TEXT),
        summary: choose(random, FREE_TEXT),
        outcome: choose(random, ["ok", "warn"]),
      };
    case 2:
      return { _tag: "item.alpha", value: choose(random, ["alpha-only", "beta-only"]) };
    case 3:
      return { _tag: "item.beta", value: choose(random, ["beta-only", "alpha-only"]) };
    case 4:
      return {
        _tag: "collection",
        items: Array.from({ length: Math.floor(random() * 3) }, item),
        labels: labels(),
        ...(random() < 0.5 ? { note: choose(random, FREE_TEXT) } : {}),
        ...(random() < 0.25 ? { "undeclared-line-text": choose(random, FREE_TEXT) } : {}),
      };
    default:
      return {
        _tag: "tuple",
        pair: ["head", choose(random, FREE_TEXT)],
        rest: Array.from({ length: Math.floor(random() * 3) }, () => choose(random, FREE_TEXT)),
        ...(random() < 0.25 ? { "undeclared-field-value": choose(random, FREE_TEXT) } : {}),
      };
  }
};

const shuffle = (random: Random, values: readonly unknown[]): readonly unknown[] => {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const left = output[index];
    const right = output[swap];
    if (left === undefined || right === undefined) continue;
    output[index] = right;
    output[swap] = left;
  }
  return output;
};

describe("policy cache equivalence", () => {
  for (const side of SIDES) {
    test(`${side} long-lived policy redacts exactly like a fresh policy`, () => {
      const redactor = createRedactor("secrets", { values: [...CACHED_SECRETS] });
      const longLived = structuralRedaction(makeCachedSchema(), side);
      expect(structuralRedaction(makeCachedSchema(), side)).not.toBe(longLived);

      const random = mulberry32(SEED);
      const values = shuffle(
        random,
        Array.from({ length: CACHE_ITERATIONS }, () => randomCachedValue(random)),
      );
      const seen = { redacted: false, alpha: false, beta: false, literal: false };
      for (const [position, value] of values.entries()) {
        const fresh = structuralRedaction(makeCachedSchema(), side);
        const cached = JSON.stringify(redactValueWithPolicy(redactor, longLived, value));
        const isolated = JSON.stringify(redactValueWithPolicy(redactor, fresh, value));
        if (cached !== isolated)
          throw new Error(
            `long-lived policy diverged from a fresh policy\nside: ${side}\nseed: ${SEED} position: ${position}\n` +
              `value: ${describeValue(value)}\ncached: ${cached}\nfresh: ${isolated}`,
          );
        seen.redacted ||= cached.includes(REDACTED);
        seen.alpha ||= cached.includes("alpha-only");
        seen.beta ||= cached.includes("beta-only");
        seen.literal ||= cached.includes("task.detail");
      }
      expect(seen).toEqual({ redacted: true, alpha: true, beta: true, literal: true });
    });
  }
});
