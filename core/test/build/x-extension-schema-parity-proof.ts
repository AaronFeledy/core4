import { expect } from "bun:test";

import type { JsonSchema } from "../../../scripts/schema-compatibility/model.ts";
import delta from "./fixtures/x-extension-schema-parity.delta.json";
import { applyParity, schemaDigest } from "./x-extension-schema-parity-edit.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const parityContext = { keys: delta.contextKeys, bodySha256: delta.contextBodySha256 };

export const evolveSchemaParity = (
  before: JsonSchema,
  surface: keyof typeof delta.checkpoints,
): JsonSchema => {
  const checkpoint = delta.checkpoints[surface];
  expect(schemaDigest(before)).toBe(checkpoint.before);
  const after = wireObject(applyParity(before, checkpoint.edit, delta.edits));
  expect(schemaDigest(after)).toBe(checkpoint.after);
  return after;
};
