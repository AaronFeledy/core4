import { describe, expect, test } from "bun:test";
import { RouteInputError } from "@lando/sdk/errors";
import type { RouteInput } from "@lando/sdk/schema";
import { Result } from "effect";
import { normalizeRoute, normalizeRoutes, parseRouteShorthand } from "../src/route-normalize.ts";

describe("route normalization", () => {
  test.each([
    ["normalizes a bare hostname", "app.lndo.site", { hostname: "app.lndo.site" }],
    ["normalizes host:port", "app.lndo.site:8080", { hostname: "app.lndo.site", endpoint: 8080 }],
    ["normalizes host/path", "app.lndo.site/api/", { hostname: "app.lndo.site", pathPrefix: "/api/" }],
    [
      "normalizes combined host:port/path wildcard shorthand",
      "lets.combine.*.lndo.site:8080/everything/for-real",
      {
        hostname: "lets.combine.*.lndo.site",
        endpoint: 8080,
        pathPrefix: "/everything/for-real",
      },
    ],
  ] as const)("%s", (_name, text, expected) => {
    // Given the authored shorthand above.
    // When
    const result = parseRouteShorthand(text);
    // Then
    expect(result).toEqual(Result.succeed(expected));
  });

  test.each(["*.app.lndo.site", "*-app.lndo.site", "wild.*.app.lndo.site", "a**b.*x*.site"])(
    "accepts leading, middle, and label-internal wildcards: %s",
    (hostname) => {
      // Given the wildcard hostname above.
      // When
      const result = parseRouteShorthand(hostname);
      // Then
      expect(result).toEqual(Result.succeed({ hostname }));
    },
  );

  test.each([
    { hostname: "app.lndo.site", scheme: "both", endpoint: "web", pathPrefix: "/api" },
    {
      hostname: "app.lndo.site",
      filters: [{ type: "requestHeader", name: "identity", header: "X-Test", value: "yes" }],
    },
  ] satisfies ReadonlyArray<RouteInput>)(
    "passes object routes through with filters defaulting to []: %j",
    (route) => {
      // Given
      Object.freeze(route);
      // When
      const result = normalizeRoute(route, { keyPath: "services.web.routes[0]" });
      // Then
      expect(result).toEqual(
        Result.succeed({ ...route, filters: route.filters ?? [], source: { key: "services.web.routes[0]" } }),
      );
    },
  );

  test("leaves scheme absent for shorthand", () => {
    // Given
    const text = "app.lndo.site:443/";
    // When
    const result = parseRouteShorthand(text);
    // Then
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(Object.hasOwn(result.success, "scheme")).toBe(false);
  });

  test.each([
    "myapp.lndo.site:8080/api",
    "myapp.lndo.site:8080",
    "myapp.lndo.site/api",
    "https://app.lndo.site",
    "",
    "api..lndo.site",
    "a b",
    "-app.site",
  ])("rejects object hostname %j at its field", (hostname) => {
    // Given
    const ctx = { keyPath: "services.web.routes[0]", file: "/app/.lando.yml" };
    // When
    const result = normalizeRoute({ hostname }, ctx);
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RouteInputError);
      expect(result.failure).toMatchObject({ key: `${ctx.keyPath}.hostname`, file: ctx.file });
      expect(result.failure.message).toContain(JSON.stringify(hostname));
      if (/[:/]/.test(hostname)) expect(result.failure.remediation).toMatch(/endpoint.*pathPrefix/);
    }
  });

  test.each(["nope", "/a b", "/a?x", "/a#x"])("rejects object pathPrefix %j at its field", (pathPrefix) => {
    // Given
    const ctx = { keyPath: "services.web.routes[0]", file: "/app/.lando.yml" };
    // When
    const result = normalizeRoute({ hostname: "app.site", pathPrefix }, ctx);
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ key: `${ctx.keyPath}.pathPrefix`, file: ctx.file });
  });

  test.each(["*.app.site", "*-app.site", "wild.*.app.site", "a**b.*x*.site"])(
    "preserves wildcard object hostname %s and route-entry provenance",
    (hostname) => {
      // Given
      const ctx = { keyPath: "services.web.routes[0]", file: "/app/.lando.yml" };
      // When
      const result = normalizeRoute({ hostname }, ctx);
      // Then
      expect(result).toEqual(
        Result.succeed({ hostname, filters: [], source: { key: ctx.keyPath, file: ctx.file } }),
      );
    },
  );

  test.each([
    "",
    " ",
    "\t",
    "http://app.lndo.site",
    "https://app.lndo.site",
    "api..lndo.site",
    ".app.site",
    "app.site.",
    "-app.site",
    "app-.site",
    "app:0",
    "app:65536",
    "app:nope",
    "app:",
    "app:1.5",
    "app:80api",
    "app\\api",
    "app?x",
    "app/path?x",
    "app#x",
    "app/path#x",
    "app site",
  ])(
    "rejects scheme prefixes, whitespace, empty labels, out-of-range ports, query, and fragment with the authored key path: %j",
    (route) => {
      // Given
      const ctx = { keyPath: "services.web.routes[2]", file: "/app/.lando.yml" };
      // When
      const result = normalizeRoute(route, ctx);
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(RouteInputError);
        expect(result.failure).toMatchObject({ key: ctx.keyPath, file: ctx.file });
        expect(result.failure.message.length).toBeGreaterThan(0);
        expect(result.failure.remediation.length).toBeGreaterThan(0);
      }
    },
  );

  test("uses proxy.<svc>[i] key paths for top-level proxy routes", () => {
    // Given
    const routes = ["app.lndo.site", "app:65536"];
    // When
    const result = normalizeRoutes(routes, { keyPath: "proxy.web" });
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.key).toBe("proxy.web[1]");
      expect(result.failure.file).toBeUndefined();
    }
  });

  test("normalizes ordered lists including port boundaries", () => {
    // Given
    const routes = ["app:1", "app:65535"];
    // When
    const result = normalizeRoutes(routes, { keyPath: "services.web.routes" });
    // Then
    expect(result).toEqual(
      Result.succeed([
        { hostname: "app", endpoint: 1, filters: [], source: { key: "services.web.routes[0]" } },
        { hostname: "app", endpoint: 65535, filters: [], source: { key: "services.web.routes[1]" } },
      ]),
    );
  });
});
