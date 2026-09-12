import { Schema } from "effect";

// ==== Provider-neutral route filters

export const RouteFilterType = Schema.Literal(
  "stripPrefix",
  "addPrefix",
  "requestHeader",
  "responseHeader",
  "redirect",
);
export type RouteFilterType = typeof RouteFilterType.Type;

const name = Schema.optional(Schema.String).annotations({
  description: "Layer-merge identity of this filter, not an HTTP header name.",
});
const prefix = Schema.NonEmptyString.pipe(Schema.pattern(/^\//)).annotations({
  description: "Non-empty path prefix beginning with a slash.",
});
const header = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9-]+$/)).annotations({
  description: "HTTP header name containing only letters, digits, and hyphens.",
});
const value = Schema.String.annotations({ description: "HTTP header value to set." });

export const RouteFilter = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("stripPrefix").annotations({ description: "Remove a request path prefix." }),
    name,
    prefix,
  }),
  Schema.Struct({
    type: Schema.Literal("addPrefix").annotations({ description: "Prepend a request path prefix." }),
    name,
    prefix,
  }),
  Schema.Struct({
    type: Schema.Literal("requestHeader").annotations({ description: "Set a request header." }),
    name,
    header,
    value,
  }),
  Schema.Struct({
    type: Schema.Literal("responseHeader").annotations({ description: "Set a response header." }),
    name,
    header,
    value,
  }),
  Schema.Struct({
    type: Schema.Literal("redirect").annotations({ description: "Redirect the request." }),
    name,
    to: Schema.NonEmptyString.annotations({ description: "Non-empty redirect destination." }),
    permanent: Schema.optional(Schema.Boolean).annotations({ description: "Use a permanent redirect." }),
  }),
);
export type RouteFilter = typeof RouteFilter.Type;
