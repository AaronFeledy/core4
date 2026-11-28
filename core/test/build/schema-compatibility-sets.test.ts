import { expect, test } from "bun:test";
import { compareArtifactSets } from "../../../scripts/check-schema-compatibility.ts";
import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import type {
  JsonSchema,
  PersistedStoreId,
  SchemaPolarity,
} from "../../../scripts/schema-compatibility/model.ts";
import { suggestCompatibilityExceptions } from "../../../scripts/schema-compatibility/suggest-exceptions.ts";

const structure = (member: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        required: ["_tag", "parts"],
        properties: {
          _tag: { const: "RouteText" },
          parts: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  required: ["service"],
                  properties: { service: { type: "string" }, member },
                },
              ],
            },
          },
        },
      },
    ],
  },
});

const memberPath = "$.additionalProperties.anyOf[0].parts.items.anyOf[0].member";
const encodings = [
  [
    "enum",
    { type: "string", enum: ["hostname", "origin"] },
    { enum: ["hostname", "origin", "protocol"], type: "string" },
    "enum",
    memberPath,
  ],
  ["const to enum", { const: "origin" }, { enum: ["hostname", "origin"] }, "enum", memberPath],
  [
    "literal union repartition",
    { anyOf: [{ enum: ["hostname", "origin"] }, { const: null }] },
    { anyOf: [{ const: "hostname" }, { enum: [null, "origin", "protocol"] }] },
    "union",
    `${memberPath}.anyOf`,
  ],
  [
    "literal arms alongside a preserved object arm",
    { anyOf: [{ type: "object" }, { enum: ["hostname", "origin"] }] },
    { anyOf: [{ type: "object" }, { const: "hostname" }, { enum: ["origin", "protocol"] }] },
    "union",
    `${memberPath}.anyOf`,
  ],
] as const;

test.each(
  encodings.flatMap(([name, smaller, larger, kind, path]) =>
    (
      [
        ["input", smaller, larger, "compatible", `${kind}-widened`],
        ["input", larger, smaller, "breaking", `${kind}-narrowed`],
        ["output", smaller, larger, "breaking", `${kind}-widened`],
        ["output", larger, smaller, "compatible", `${kind}-narrowed`],
        ["strict", smaller, larger, "unknown", `${kind}-widened`],
        ["strict", larger, smaller, "unknown", `${kind}-narrowed`],
      ] as const
    ).map(
      ([polarity, before, after, verdict, changeKind]) =>
        [name, polarity, before, after, verdict, changeKind, path] as const,
    ),
  ),
)("classifies %s as %s (%j to %j)", (_name, polarity, before, after, verdict, changeKind, path) => {
  const findings = classifySchemaChange(structure(before), structure(after), polarity);

  expect(findings).toEqual([expect.objectContaining({ verdict, changeKind, path })]);
});

test.each([
  ["overlap without inclusion", { enum: ["a", "b"] }, { enum: ["b", "c"] }],
  [
    "different directions",
    { properties: { a: { const: "a" }, b: { enum: ["a", "b"] } } },
    { properties: { a: { enum: ["a", "b"] }, b: { const: "a" } } },
  ],
  ["changed sibling constraint", { enum: ["a"], minLength: 1 }, { enum: ["a", "b"], minLength: 2 }],
  [
    "overlapping oneOf",
    { oneOf: [{ enum: ["a", "b"] }, { const: "a" }] },
    { oneOf: [{ enum: ["a", "b", "c"] }, { const: "a" }] },
  ],
  ["unresolved references", { $ref: "external", enum: ["a"] }, { $ref: "external", enum: ["a", "b"] }],
  [
    "unevaluated property constraints",
    { properties: { mode: { const: "a" } }, unevaluatedProperties: false },
    { properties: { mode: { enum: ["a", "b"] } }, unevaluatedProperties: false },
  ],
] satisfies readonly (readonly [string, JsonSchema, JsonSchema])[])(
  "leaves %s for explicit review",
  (_name, before, after) => {
    expect(classifySchemaChange(structure(before), structure(after), "input")).toEqual([
      expect.objectContaining({ verdict: "unknown", accepted: false }),
    ]);
  },
);

test("does not mistake changes to conflicting reference constraints for widening", () => {
  const before = {
    ...structure({ $ref: "#/$defs/Mode", enum: ["a"] }),
    $defs: { Mode: { enum: ["a"] } },
  };
  const after = {
    ...structure({ $ref: "#/$defs/Mode", enum: ["a", "b"] }),
    $defs: { Mode: { enum: ["b", "c"] } },
  };

  expect(classifySchemaChange(before, after, "input")).toEqual([
    expect.objectContaining({ verdict: "unknown" }),
  ]);
});

test("treats equivalent literal encodings as unchanged even on a strict surface", () => {
  const before = structure({ const: "origin" });
  const after = structure({ enum: ["origin"] });

  expect(classifySchemaChange(before, after, "strict")).toEqual([]);
});

test("reports one finding when both literal and structural arms widen the same union", () => {
  const before = { anyOf: [{ const: "a" }, { type: "object" }] };
  const after = { anyOf: [{ enum: ["a", "b"] }, { type: "object" }, { type: "number" }] };

  expect(classifySchemaChange(before, after, "input")).toEqual([
    expect.objectContaining({ path: "$.anyOf", verdict: "compatible", changeKind: "union-widened" }),
  ]);
});

const publicSurface = "schema:Environment";
const storedSurface = "persisted:scratch-registry";
const stores: ReadonlyMap<string, ReadonlySet<PersistedStoreId>> = new Map([
  [publicSurface, new Set(["applied-state", "tunnel-registry"])],
]);
const artifacts = (schema: JsonSchema, version: number, polarity: SchemaPolarity = "strict") =>
  new Map([
    [publicSurface, { surface: publicSurface, polarity, schema }],
    [
      storedSurface,
      {
        surface: storedSurface,
        polarity: "input" as const,
        schema,
        persistedState: { store: "scratch-registry" as const, version },
      },
    ],
  ]);

test.each(
  encodings.flatMap(([name, smaller, larger, kind, path]) =>
    (
      [
        [2, 2, 2, true, true],
        [1, 2, 1, false, false],
        [2, 1, 2, false, true],
      ] as const
    ).map(
      ([applied, tunnel, internal, publicAccepted, internalAccepted]) =>
        [
          name,
          smaller,
          larger,
          kind,
          path,
          applied,
          tunnel,
          internal,
          publicAccepted,
          internalAccepted,
        ] as const,
    ),
  ),
)(
  "requires each persisted version to advance for %s (%j to %j, %s at %s; versions %s/%s/%s)",
  (_name, smaller, larger, kind, path, applied, tunnel, internal, publicAccepted, internalAccepted) => {
    const policy = {
      persistedStoresBySurface: stores,
      baseStoreVersions: { "applied-state": 1, "tunnel-registry": 1 },
      storeVersions: { "applied-state": applied, "tunnel-registry": tunnel },
      exceptions: [],
    };

    const findings = compareArtifactSets(
      artifacts(structure(smaller), 1, "input"),
      artifacts(structure(larger), internal, "input"),
      policy,
    );

    expect(findings).toEqual([
      expect.objectContaining({
        surface: storedSurface,
        verdict: internalAccepted ? "compatible" : "breaking",
        changeKind: `${kind}-widened`,
        path,
        accepted: internalAccepted,
      }),
      expect.objectContaining({
        surface: publicSurface,
        verdict: publicAccepted ? "compatible" : "breaking",
        changeKind: `${kind}-widened`,
        path,
        accepted: publicAccepted,
      }),
    ]);
    expect(suggestCompatibilityExceptions(findings, [], policy)).toEqual([]);
  },
);

test.each(encodings)(
  "requires review after a persisted narrowing of %s even with a version increase",
  (_name, smaller, larger, kind, path) => {
    const policy = {
      persistedStoresBySurface: stores,
      baseStoreVersions: { "applied-state": 1, "tunnel-registry": 1 },
      storeVersions: { "applied-state": 2, "tunnel-registry": 2 },
      exceptions: [],
    };

    const findings = compareArtifactSets(
      artifacts(structure(larger), 1),
      artifacts(structure(smaller), 2),
      policy,
    );

    expect(findings).toEqual([
      expect.objectContaining({
        surface: storedSurface,
        verdict: "breaking",
        changeKind: `${kind}-narrowed`,
        path,
        accepted: false,
      }),
      expect.objectContaining({
        surface: publicSurface,
        verdict: "breaking",
        changeKind: `${kind}-narrowed`,
        path,
        accepted: false,
      }),
    ]);
  },
);
