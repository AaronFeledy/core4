import { Schema } from "effect";

// ==== Provider-neutral route filters

export const RouteFilterType = Schema.Literals(["stripPrefix", "addPrefix", "requestHeader", "responseHeader", "redirect"]);
export type RouteFilterType = typeof RouteFilterType.Type;

const name = Schema.optionalKey(Schema.String).annotate({
  description: "Layer-merge identity of this filter, not an HTTP header name.",
});
const prefix = Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^\//))).annotate({
  description: "Non-empty path prefix beginning with a slash.",
});
const header = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9-]+$/))).annotate({
  description: "HTTP header name containing only letters, digits, and hyphens.",
});
const value = Schema.String.annotate({ description: "HTTP header value to set." });

export const RouteFilter = Schema.Union([Schema.Struct({
    type: Schema.Literal("stripPrefix").annotate({ description: "Remove a request path prefix." }),
    name,
    prefix,
  }), Schema.Struct({
    type: Schema.Literal("addPrefix").annotate({ description: "Prepend a request path prefix." }),
    name,
    prefix,
  }), Schema.Struct({
    type: Schema.Literal("requestHeader").annotate({ description: "Set a request header." }),
    name,
    header,
    value,
  }), Schema.Struct({
    type: Schema.Literal("responseHeader").annotate({ description: "Set a response header." }),
    name,
    header,
    value,
  }), Schema.Struct({
    type: Schema.Literal("redirect").annotate({ description: "Redirect the request." }),
    name,
    to: Schema.NonEmptyString.annotate({ description: "Non-empty redirect destination." }),
    permanent: Schema.optionalKey(Schema.Boolean).annotate({ description: "Use a permanent redirect." }),
  })]);
export type RouteFilter = typeof RouteFilter.Type;
