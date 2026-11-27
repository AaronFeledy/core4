import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { environmentDeltas } from "./fixtures/x-extension-environment.delta.ts";
import { routeMemberDeltas, routeTextDeltas } from "./fixtures/x-extension-route-text.delta.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const compileTransitions = (deltas: typeof environmentDeltas) =>
  deltas.flatMap(({ mode, before, after }) => {
    const previous = wireObject(before.properties);
    const next = wireObject(after.properties);
    return Object.entries(previous).map(([key, value]) => ({ mode, key, before: value, after: next[key] }));
  });

/** Replay only exact reviewed field projections; never replace a surrounding object or union. */
const replayFields = (deltas: typeof environmentDeltas) => {
  const transitions = compileTransitions(deltas);
  return (historical: JsonSchema, mode: "bare" | "authoring" = "bare"): JsonSchema => {
    const visit = (value: JsonValue): JsonValue => {
      if (Array.isArray(value)) return value.map(visit);
      if (!isJsonObject(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key !== "properties" || !isJsonObject(child)) return [key, visit(child)];
          return [
            key,
            Object.fromEntries(
              Object.entries(child).map(([field, schema]) => {
                const transition = transitions.find(
                  (entry) =>
                    (mode === "bare" ? entry.mode === "bare" : entry.mode !== "bare") &&
                    entry.key === field &&
                    jsonEquals(schema, entry.before),
                );
                return [
                  field,
                  transition?.after === undefined ? visit(schema) : structuredClone(transition.after),
                ];
              }),
            ),
          ];
        }),
      );
    };
    return normalizeJsonSchema(wireObject(visit(historical)));
  };
};

export const evolveHistoricalEnvironment = replayFields(environmentDeltas);
export const evolveHistoricalRouteText = replayFields(routeTextDeltas);

/** Replay one exact reviewed object projection wherever it occurs; a near miss stays unchanged. */
const replayObject = (deltas: typeof routeMemberDeltas) => {
  return (historical: JsonSchema, mode: "bare" | "authoring" = "bare"): JsonSchema => {
    const transitions = deltas.filter((entry) =>
      mode === "bare" ? entry.mode === "bare" : entry.mode !== "bare",
    );
    const visit = (value: JsonValue): JsonValue => {
      const transition = transitions.find((entry) => jsonEquals(value, entry.before));
      if (transition !== undefined) return structuredClone(transition.after);
      if (Array.isArray(value)) return value.map(visit);
      if (!isJsonObject(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    };
    return normalizeJsonSchema(wireObject(visit(historical)));
  };
};

/** Route parts gained the optional member after the schema parity checkpoint, so replay it after parity. */
export const evolveHistoricalRouteMember = replayObject(routeMemberDeltas);
