import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import capture from "./fixtures/x-extension-project-user.delta.json";
import { wireObject } from "./x-extension-wire-proof.ts";

const modes = wireObject(capture.modes);
const readMode = (mode: "plain" | "directive") => {
  const row = wireObject(modes[mode]);
  return { witness: wireObject(row.witness), field: wireObject(row.field) };
};

/** Independently reviewed `projectUser` projections, pinned with their source provenance. */
export const projectUserDelta = {
  provenance: capture.provenance,
  pointer: capture.pointer,
  plain: readMode("plain"),
  directive: readMode("directive"),
};

/**
 * Replay only the reviewed optional `projectUser` field on every historical service
 * record. `plain` is the bare/service projection; `directive` is the directive-capable
 * fragment projection. A service must still carry the exact reviewed user contract,
 * so an unreviewed constraint is preserved rather than hidden by the addition.
 */
export const evolveHistoricalProjectUser = (
  historical: JsonSchema,
  projection: "plain" | "directive",
): JsonSchema => {
  const { witness, field } = projectUserDelta[projection];
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const fields = next.properties;
    if (
      value.type !== "object" ||
      !isJsonObject(fields) ||
      fields.type === undefined ||
      fields.image === undefined ||
      fields.ports === undefined ||
      fields.projectUser !== undefined ||
      !jsonEquals(fields.user, witness)
    )
      return next;
    return { ...next, properties: { ...fields, projectUser: structuredClone(field) } };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
