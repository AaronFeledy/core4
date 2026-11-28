import { Schema } from "effect";
import { isWildcardHostname } from "./hostname.ts";
import { PortNumber } from "./primitives.ts";

// ============================================================================
// Public route address vocabulary shared by service routes and scratch routes.
// ============================================================================

const host = Schema.String.annotate({
  description: "Published route hostname, lowercase. A wildcard hostname pattern when hostMatch is pattern.",
});
const where = {
  protocol: Schema.Literals(["http", "https"]).annotate({ description: "External HTTP route scheme." }),
  pathPrefix: Schema.String.annotate({
    description: "Path prefix the route matches and its URL keeps; empty when the route matches every path.",
  }),
};
const exact = {
  hostMatch: Schema.Literal("exact").annotate({ description: "The host is one concrete hostname." }),
};
const pattern = {
  hostMatch: Schema.Literal("pattern").annotate({
    description: "The host is a wildcard pattern that matches many hostnames, so no URL names it.",
  }),
};
const served = { port: PortNumber.annotate({ description: "Router port that serves this route." }) };

const concreteHost = Schema.makeFilter((value: string) => !isWildcardHostname(value), {
  message: "Expected a hostname without a wildcard.",
  toJsonSchema: () => ({ pattern: "^[^*]*$" }),
});
const wildcardHost = Schema.makeFilter(isWildcardHostname, {
  message: "Expected a hostname with a wildcard.",
  toJsonSchema: () => ({ pattern: "\\*" }),
});

export const exactRouteHost = {
  host: host.check(concreteHost),
  ...where,
  ...exact,
};
export const patternRouteHost = {
  host: host.check(wildcardHost),
  ...where,
  ...pattern,
};

export const exactRouteAddress = {
  ...exactRouteHost,
  ...served,
  url: Schema.String.annotate({
    description: "Client URL: scheme, hostname, any nonstandard port, and path prefix.",
  }),
};
export const patternRouteAddress = {
  ...patternRouteHost,
  ...served,
  url: Schema.optionalKey(Schema.Never).annotate({ description: "A hostname pattern has no URL." }),
};
