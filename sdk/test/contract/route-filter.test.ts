import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import {
  ContractFailure,
  type RouteFilterContractHarness,
  RouteFilterError,
  makeRouteFilterContractSuite,
  runRouteFilterContractSuite,
} from "@lando/sdk/test";

// Fixture-local RoutePlan extension carrying header/redirect metadata so the
// six built-in filters can be exercised WITHOUT widening the SDK RoutePlan
// schema. The base fields mirror `sdk/src/schema/networking.ts` RoutePlan.
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

const allFilters = [rewritePath, stripPrefix, addPrefix, requestHeader, responseHeader, redirect];

describe("RouteFilter contract", () => {
  for (const filter of allFilters) {
    test(`the built-in ${filter.id} filter passes the contract`, async () => {
      const exit = await Effect.runPromiseExit(runRouteFilterContractSuite(filter));
      if (exit._tag === "Failure") {
        throw new Error(`Contract failure (${filter.id}): ${JSON.stringify(exit.cause, null, 2)}`);
      }
      expect(exit._tag).toBe("Success");
    });
  }

  test("optional capability + replay probes pass when supplied", async () => {
    const exit = await Effect.runPromiseExit(
      runRouteFilterContractSuite({
        ...rewritePath,
        capabilities: ["rewritePath"],
        behaviorTags: ["rewritePath"],
        applySequence: [
          { ...baseRoute, pathPrefix: "/a" },
          { ...baseRoute, pathPrefix: "/b" },
        ],
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("a non-idempotent filter fails the contract", async () => {
    const bad: Filter<{ prefix: string }> = {
      id: "badAddPrefix",
      schema: Schema.Struct({ prefix: Schema.String }),
      validOptions: { prefix: "/api" },
      invalidOptions: {},
      input: { ...baseRoute, pathPrefix: "/x" },
      // Always prepends → applying twice changes the output again (not idempotent).
      apply: (route, options) =>
        Effect.succeed({ ...route, pathPrefix: `${options.prefix}${route.pathPrefix ?? ""}` }),
      expected: { ...baseRoute, pathPrefix: "/api/x" },
    };
    const exit = await Effect.runPromiseExit(runRouteFilterContractSuite(bad));
    expect(exit._tag).toBe("Failure");
  });

  test("makeRouteFilterContractSuite is an alias", () => {
    expect(makeRouteFilterContractSuite).toBe(runRouteFilterContractSuite);
  });

  test("RouteFilterError and ContractFailure are exported", () => {
    expect(RouteFilterError).toBeDefined();
    expect(ContractFailure).toBeDefined();
  });
});
