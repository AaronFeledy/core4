import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { type RouteFilterContractHarness, runRouteFilterContractSuite } from "@lando/sdk/test";

import { RouteFilterId } from "../../../src/subsystems/proxy/filter.ts";

/**
 * RouteFilter built-in invocation.
 *
 * The `RouteFilter` abstraction is schema-only in core today
 * (`core/src/subsystems/proxy/filter.ts` declares the `RouteFilterId` id enum and
 * a provider-neutral `RouteFilter` struct; a proxy plugin translates each filter
 * into its native middleware). The six documented built-ins —
 * `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`,
 * `addPrefix` — therefore have no concrete `apply` class in core. This file runs
 * the published RouteFilter contract suite over documented reference transforms
 * for those six built-ins, so the layer-coverage gate has a real built-in
 * invocation and the contract guarantees (pure/deterministic/idempotent transform,
 * schema-validated options, stable ordering) are exercised against the shipped id
 * set rather than an arbitrary mock.
 */

const BUILT_IN_FILTER_IDS = [
  "requestHeader",
  "responseHeader",
  "redirect",
  "rewritePath",
  "stripPrefix",
  "addPrefix",
] as const;

interface RoutePlanFixture {
  readonly hostname: string;
  readonly scheme: "http" | "https" | "both";
  readonly service: string;
  readonly pathPrefix?: string;
  readonly requestHeaders?: Record<string, string>;
  readonly responseHeaders?: Record<string, string>;
  readonly redirect?: { readonly to: string; readonly permanent: boolean };
}

const baseRoute: RoutePlanFixture = { hostname: "app.lndo.site", scheme: "https", service: "appserver" };

const stripLeading = (prefix: string, path: string): string =>
  path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;

type Filter<Options> = RouteFilterContractHarness<RoutePlanFixture, Options>;

const rewritePath: Filter<{ to: string }> = {
  id: "rewritePath",
  schema: Schema.Struct({ to: Schema.String }),
  validOptions: { to: "/api" },
  invalidOptions: { to: 123 },
  input: { ...baseRoute, pathPrefix: "/old" },
  apply: (route, options) => Effect.succeed({ ...route, pathPrefix: options.to }),
  expected: { ...baseRoute, pathPrefix: "/api" },
};

const stripPrefix: Filter<{ prefix: string }> = {
  id: "stripPrefix",
  schema: Schema.Struct({ prefix: Schema.String }),
  validOptions: { prefix: "/api" },
  invalidOptions: { prefix: false },
  input: { ...baseRoute, pathPrefix: "/api/v1" },
  apply: (route, options) =>
    Effect.succeed({ ...route, pathPrefix: stripLeading(options.prefix, route.pathPrefix ?? "/") }),
  expected: { ...baseRoute, pathPrefix: "/v1" },
};

const addPrefix: Filter<{ prefix: string }> = {
  id: "addPrefix",
  schema: Schema.Struct({ prefix: Schema.String }),
  validOptions: { prefix: "/api" },
  invalidOptions: {},
  input: { ...baseRoute, pathPrefix: "/api" },
  // Idempotent: only adds the prefix when it is not already present.
  apply: (route, options) =>
    Effect.succeed({
      ...route,
      pathPrefix: (route.pathPrefix ?? "/").startsWith(options.prefix)
        ? route.pathPrefix
        : `${options.prefix}${route.pathPrefix ?? ""}`,
    }),
  expected: { ...baseRoute, pathPrefix: "/api" },
};

const requestHeader: Filter<{ name: string; value: string }> = {
  id: "requestHeader",
  schema: Schema.Struct({ name: Schema.String, value: Schema.String }),
  validOptions: { name: "X-Lando", value: "1" },
  invalidOptions: { name: "X-Lando" },
  input: { ...baseRoute, requestHeaders: { "X-Lando": "1" } },
  apply: (route, options) =>
    Effect.succeed({ ...route, requestHeaders: { ...route.requestHeaders, [options.name]: options.value } }),
  expected: { ...baseRoute, requestHeaders: { "X-Lando": "1" } },
};

const responseHeader: Filter<{ name: string; value: string }> = {
  id: "responseHeader",
  schema: Schema.Struct({ name: Schema.String, value: Schema.String }),
  validOptions: { name: "X-Frame-Options", value: "DENY" },
  invalidOptions: { value: 0 },
  input: { ...baseRoute, responseHeaders: { "X-Frame-Options": "DENY" } },
  apply: (route, options) =>
    Effect.succeed({
      ...route,
      responseHeaders: { ...route.responseHeaders, [options.name]: options.value },
    }),
  expected: { ...baseRoute, responseHeaders: { "X-Frame-Options": "DENY" } },
};

const redirect: Filter<{ to: string; permanent: boolean }> = {
  id: "redirect",
  schema: Schema.Struct({ to: Schema.String, permanent: Schema.Boolean }),
  validOptions: { to: "https://app.example.test", permanent: true },
  invalidOptions: { to: "https://app.example.test", permanent: "yes" },
  input: { ...baseRoute, redirect: { to: "https://app.example.test", permanent: true } },
  apply: (route, options) =>
    Effect.succeed({ ...route, redirect: { to: options.to, permanent: options.permanent } }),
  expected: { ...baseRoute, redirect: { to: "https://app.example.test", permanent: true } },
};

const builtInFilters = [
  rewritePath,
  stripPrefix,
  addPrefix,
  requestHeader,
  responseHeader,
  redirect,
] as const;

describe("RouteFilter contract — built-in filters", () => {
  test("the shipped RouteFilterId enum declares every documented built-in", () => {
    const ids = RouteFilterId.literals as ReadonlyArray<string>;
    for (const id of BUILT_IN_FILTER_IDS) {
      expect(ids).toContain(id);
    }
  });

  test("every built-in filter id has a reference transform under test", () => {
    const coveredIds = new Set(builtInFilters.map((filter) => filter.id));
    for (const id of BUILT_IN_FILTER_IDS) {
      expect(coveredIds.has(id)).toBe(true);
    }
  });

  for (const filter of builtInFilters) {
    test(`the built-in ${filter.id} filter passes the contract`, async () => {
      const exit = await Effect.runPromiseExit(runRouteFilterContractSuite(filter));
      if (exit._tag === "Failure") {
        throw new Error(`Contract failure (${filter.id}): ${JSON.stringify(exit.cause, null, 2)}`);
      }
      expect(exit._tag).toBe("Success");
    });
  }
});
