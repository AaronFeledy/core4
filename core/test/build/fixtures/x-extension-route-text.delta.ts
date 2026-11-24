import { Schema } from "effect";
import {
  REVIEWED_COMPOSITE_EXPRESSION_PATTERN,
  REVIEWED_WHOLE_EXPRESSION_PATTERN,
} from "../x-extension-authoring-projection-proof.ts";
import {
  environmentDeltas,
  environmentFields,
  environmentProjection,
  historicalEnvironment,
  historicalEnvironmentValue,
} from "./x-extension-environment.delta.ts";

const routePart = Schema.Struct({
  service: Schema.String,
  encoding: Schema.Literals(["raw", "uri-component"]),
});
const routeText = Schema.Struct({
  _tag: Schema.Literal("RouteText"),
  parts: Schema.Array(Schema.Union([Schema.String, routePart])).check(Schema.isMaxLength(10_000)),
});
const value = Schema.Union([...historicalEnvironmentValue.members, routeText]);
const environment = historicalEnvironment(value);
const next = environmentFields(value, environment, environment);
const oldEnvironment = historicalEnvironment(historicalEnvironmentValue);
const previous = environmentFields(historicalEnvironmentValue, oldEnvironment, oldEnvironment);
const reviewedSlot = (kind: string) =>
  Schema.String.check(
    Schema.makeFilter(() => true, {
      "~structural": true,
      toJsonSchema: () => ({
        pattern:
          kind === "string" ? REVIEWED_COMPOSITE_EXPRESSION_PATTERN : REVIEWED_WHOLE_EXPRESSION_PATTERN,
      }),
    }),
  );

export const routeTextDeltas = environmentDeltas.map(({ mode }, index) => ({
  mode,
  before: environmentProjection(previous[index % 2 === 0 ? 0 : 1], mode, reviewedSlot),
  after: environmentProjection(next[index % 2 === 0 ? 0 : 1], mode, reviewedSlot),
}));

// Reviewed later: a part may name the route fact it reads (hostname or origin) instead of the URL.
const memberRoutePart = Schema.Struct({
  service: Schema.String,
  member: Schema.optionalKey(Schema.Literals(["hostname", "origin"])),
  encoding: Schema.Literals(["raw", "uri-component"]),
});

export const routeMemberDeltas = environmentDeltas.map(({ mode }) => ({
  mode,
  before: environmentProjection(routePart, mode, reviewedSlot),
  after: environmentProjection(memberRoutePart, mode, reviewedSlot),
}));
