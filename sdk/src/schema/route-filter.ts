import { Schema } from "effect";

// ==== Provider-neutral route filters

const PREFIX_PATTERN = /^\//;
const HEADER_PATTERN = /^[A-Za-z0-9-]+$/;

export const RouteFilterType = Schema.Literals([
  "stripPrefix",
  "addPrefix",
  "requestHeader",
  "responseHeader",
  "redirect",
]);
export type RouteFilterType = typeof RouteFilterType.Type;

const name = Schema.optionalKey(Schema.String).annotate({
  description: "Layer-merge identity of this filter, not an HTTP header name.",
});
const prefix = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(PREFIX_PATTERN, {
      message: "Expected a path prefix starting with /",
      toJsonSchema: () => ({ pattern: PREFIX_PATTERN.source }),
    }),
  ),
).annotate({
  description: "Non-empty path prefix beginning with a slash.",
});
const header = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(HEADER_PATTERN, {
      message: "Expected an HTTP header name containing only letters, digits, and hyphens",
      toJsonSchema: () => ({ pattern: HEADER_PATTERN.source }),
    }),
  ),
).annotate({
  description: "HTTP header name containing only letters, digits, and hyphens.",
});
const value = Schema.String.annotate({ description: "HTTP header value to set." });

const filterArms = [
  Schema.Struct({
    type: Schema.Literal("stripPrefix").annotate({ description: "Remove a request path prefix." }),
    name,
    prefix,
  }),
  Schema.Struct({
    type: Schema.Literal("addPrefix").annotate({ description: "Prepend a request path prefix." }),
    name,
    prefix,
  }),
  Schema.Struct({
    type: Schema.Literal("requestHeader").annotate({ description: "Set a request header." }),
    name,
    header,
    value,
  }),
  Schema.Struct({
    type: Schema.Literal("responseHeader").annotate({ description: "Set a response header." }),
    name,
    header,
    value,
  }),
  Schema.Struct({
    type: Schema.Literal("redirect").annotate({ description: "Redirect the request." }),
    name,
    to: Schema.NonEmptyString.annotate({ description: "Non-empty redirect destination." }),
    permanent: Schema.optionalKey(Schema.Boolean).annotate({ description: "Use a permanent redirect." }),
  }),
] as const;

export const RouteFilter = Schema.Union(filterArms).annotate({
  expected: "a filter with type stripPrefix, addPrefix, requestHeader, responseHeader, or redirect",
});
export type RouteFilter = typeof RouteFilter.Type;

export const RouteFilterInput = Schema.Union([
  filterArms[0].pipe(Schema.encodeKeys({ type: "kind" })),
  filterArms[1].pipe(Schema.encodeKeys({ type: "kind" })),
  filterArms[2].pipe(Schema.encodeKeys({ type: "kind" })),
  filterArms[3].pipe(Schema.encodeKeys({ type: "kind" })),
  filterArms[4].pipe(Schema.encodeKeys({ type: "kind" })),
]).annotate({
  expected: "a filter with kind stripPrefix, addPrefix, requestHeader, responseHeader, or redirect",
});
