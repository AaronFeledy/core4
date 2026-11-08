import { createHash } from "node:crypto";
import { type JsonSchema, type JsonValue, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import capture from "./fixtures/x-extension-authoring-projection.delta.json";
import { wireObject } from "./x-extension-wire-proof.ts";

export const authoringProjectionBytes = Bun.gunzipSync(Buffer.from(capture.gzipBase64.join(""), "base64"));
export const authoringProjectionDelta = wireObject(
  JSON.parse(new TextDecoder().decode(authoringProjectionBytes)),
);
const edits = authoringProjectionDelta.edits;
const steps = authoringProjectionDelta.steps;
if (!Array.isArray(edits) || !Array.isArray(steps)) throw new TypeError("Missing reviewed projection edits");
const wholePattern = wireObject(edits[0]).after;
if (typeof wholePattern !== "string") throw new TypeError("Missing reviewed whole-expression pattern");
export const REVIEWED_WHOLE_EXPRESSION_PATTERN = wholePattern;
const stringAlternatives = wireObject(wireObject(edits[1]).after).anyOf;
if (!Array.isArray(stringAlternatives)) throw new TypeError("Missing reviewed string alternatives");
const compositePattern = wireObject(stringAlternatives[1]).pattern;
if (typeof compositePattern !== "string") throw new TypeError("Missing reviewed composite pattern");
export const REVIEWED_COMPOSITE_EXPRESSION_PATTERN = compositePattern;

// The interned trie encodes exact historical paths, not shape-based replacement rules.
const replay = (value: JsonValue, index: number): JsonValue => {
  const step = wireObject(steps[index]);
  if (typeof step.edit === "number") {
    const edit = wireObject(edits[step.edit]);
    if (!jsonEquals(value, edit.before) || edit.after === undefined)
      throw new TypeError("Expected exact reviewed authoring node");
    return structuredClone(edit.after);
  }
  const children = wireObject(step.children);
  const container = Array.isArray(value) ? value : wireObject(value);
  const entries = Object.entries(container);
  if (Object.keys(children).some((key) => !Object.hasOwn(container, key)))
    throw new TypeError("Missing reviewed authoring path");
  const changed = entries.map(([key, child]) => {
    const target = children[key];
    if (target === undefined) return [key, child] as const;
    if (typeof target !== "number") throw new TypeError("Invalid reviewed authoring step");
    return [key, replay(child, target)] as const;
  });
  return Array.isArray(value) ? changed.map(([, child]) => child) : Object.fromEntries(changed);
};

export const evolveHistoricalAuthoringProjection = (
  historical: JsonSchema,
  profile: "services" | "fragment" | "input",
): JsonSchema => {
  const proof = wireObject(wireObject(authoringProjectionDelta.profiles)[profile]);
  const digest = createHash("sha256").update(JSON.stringify(historical)).digest("hex");
  if (digest !== proof.beforeSha256 || typeof proof.step !== "number")
    throw new TypeError(`Expected independently pinned ${profile} projection before evolution`);
  return normalizeJsonSchema(wireObject(replay(historical, proof.step)));
};
