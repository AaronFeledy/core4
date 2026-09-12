import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { attachRouteFilter } from "@lando/landofile/route-filters";
import { RouteFilter, RouteFilterType } from "@lando/sdk/schema";
import { type RouteFilterContractHarness, runRouteFilterContractSuite } from "@lando/sdk/test";

/**
 * RouteFilter built-in invocation.
 *
 * The five shipped authorable filters — `stripPrefix`, `addPrefix`,
 * `requestHeader`, `responseHeader`, `redirect` — attach through
 * `attachRouteFilter` onto the route's `filters` array. `rewritePath` remains
 * a contract-only reference transform; core does not ship it as an authorable
 * filter type.
 */

const SHIPPED_FILTER_IDS = RouteFilterType.literals;
const REFERENCE_FILTER_IDS = ["rewritePath"] as const;

const [stripPrefixSchema, addPrefixSchema, requestHeaderSchema, responseHeaderSchema, redirectSchema] =
  RouteFilter.members;

type Route = {
  readonly hostname: string;
  readonly scheme: "http" | "https" | "both";
  readonly service: string;
  readonly pathPrefix?: string;
  readonly filters?: ReadonlyArray<unknown>;
};

type Filter<Options> = RouteFilterContractHarness<Route, Options>;

const baseRoute: Route = { hostname: "app.lndo.site", scheme: "https", service: "appserver" };

const applyShipped = (route: Route, filter: unknown): Effect.Effect<Route> =>
  Effect.succeed(attachRouteFilter(route, filter));

/**
 * Contract-only reference transform. Core does not ship `rewritePath` as an
 * authorable filter type.
 */
const rewritePath: Filter<{ to: string }> = {
  id: "rewritePath",
  schema: Schema.Struct({ to: Schema.String }),
  validOptions: { to: "/api" },
  invalidOptions: { to: 123 },
  input: { ...baseRoute, pathPrefix: "/old" },
  apply: (route, options) => Effect.succeed({ ...route, pathPrefix: options.to }),
  expected: { ...baseRoute, pathPrefix: "/api" },
  applySequence: [
    { ...baseRoute, pathPrefix: "/a" },
    { ...baseRoute, pathPrefix: "/b" },
  ],
};

const stripPrefixFilter = { type: "stripPrefix", prefix: "/api" } as const;
const stripPrefix: Filter<typeof stripPrefixFilter> = {
  id: "stripPrefix",
  schema: stripPrefixSchema,
  validOptions: stripPrefixFilter,
  invalidOptions: { type: "stripPrefix", prefix: false },
  input: baseRoute,
  apply: applyShipped,
  expected: { ...baseRoute, filters: [stripPrefixFilter] },
  applySequence: [baseRoute, { ...baseRoute, hostname: "other.lndo.site" }],
};

const addPrefixFilter = { type: "addPrefix", prefix: "/api" } as const;
const addPrefix: Filter<typeof addPrefixFilter> = {
  id: "addPrefix",
  schema: addPrefixSchema,
  validOptions: addPrefixFilter,
  invalidOptions: {},
  input: baseRoute,
  apply: applyShipped,
  expected: { ...baseRoute, filters: [addPrefixFilter] },
  applySequence: [baseRoute, { ...baseRoute, hostname: "other.lndo.site" }],
};

const requestHeaderFilter = { type: "requestHeader", header: "X-Lando", value: "1" } as const;
const requestHeader: Filter<typeof requestHeaderFilter> = {
  id: "requestHeader",
  schema: requestHeaderSchema,
  validOptions: requestHeaderFilter,
  invalidOptions: { type: "requestHeader", header: "X-Lando" },
  input: baseRoute,
  apply: applyShipped,
  expected: { ...baseRoute, filters: [requestHeaderFilter] },
  applySequence: [baseRoute, { ...baseRoute, hostname: "other.lndo.site" }],
};

const responseHeaderFilter = { type: "responseHeader", header: "X-Frame-Options", value: "DENY" } as const;
const responseHeader: Filter<typeof responseHeaderFilter> = {
  id: "responseHeader",
  schema: responseHeaderSchema,
  validOptions: responseHeaderFilter,
  invalidOptions: { type: "responseHeader", value: 0 },
  input: baseRoute,
  apply: applyShipped,
  expected: { ...baseRoute, filters: [responseHeaderFilter] },
  applySequence: [baseRoute, { ...baseRoute, hostname: "other.lndo.site" }],
};

const redirectFilter = { type: "redirect", to: "https://app.example.test", permanent: true } as const;
const redirect: Filter<typeof redirectFilter> = {
  id: "redirect",
  schema: redirectSchema,
  validOptions: redirectFilter,
  invalidOptions: { type: "redirect", to: "https://app.example.test", permanent: "yes" },
  input: baseRoute,
  apply: applyShipped,
  expected: { ...baseRoute, filters: [redirectFilter] },
  applySequence: [baseRoute, { ...baseRoute, hostname: "other.lndo.site" }],
};

const builtInFilters = [
  { id: rewritePath.id, run: () => runRouteFilterContractSuite(rewritePath) },
  { id: stripPrefix.id, run: () => runRouteFilterContractSuite(stripPrefix) },
  { id: addPrefix.id, run: () => runRouteFilterContractSuite(addPrefix) },
  { id: requestHeader.id, run: () => runRouteFilterContractSuite(requestHeader) },
  { id: responseHeader.id, run: () => runRouteFilterContractSuite(responseHeader) },
  { id: redirect.id, run: () => runRouteFilterContractSuite(redirect) },
] as const;

describe("RouteFilter contract — built-in filters", () => {
  test("the shipped RouteFilterType declares every documented built-in", () => {
    expect([...SHIPPED_FILTER_IDS]).toEqual([
      "stripPrefix",
      "addPrefix",
      "requestHeader",
      "responseHeader",
      "redirect",
    ]);
  });

  test("every built-in filter id has a reference transform under test", () => {
    const coveredIds = new Set(builtInFilters.map((filter) => filter.id));
    for (const id of [...SHIPPED_FILTER_IDS, ...REFERENCE_FILTER_IDS]) {
      expect(coveredIds.has(id)).toBe(true);
    }
  });

  for (const filter of builtInFilters) {
    test(`the built-in ${filter.id} filter passes the contract`, async () => {
      const exit = await Effect.runPromiseExit(filter.run());
      if (exit._tag === "Failure") {
        throw new Error(`Contract failure (${filter.id}): ${JSON.stringify(exit.cause, null, 2)}`);
      }
      expect(exit._tag).toBe("Success");
    });
  }
});
