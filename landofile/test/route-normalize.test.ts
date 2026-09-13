import { describe, expect, test } from "bun:test";
import { RouteInputError } from "@lando/sdk/errors";
import type { RouteInput } from "@lando/sdk/schema";
import { Either } from "effect";
import { normalizeRoute, normalizeRoutes, parseRouteShorthand } from "../src/route-normalize.ts";

describe("route normalization", () => {
  test.each([
    ["normalizes a bare hostname", "app.lndo.site", { hostname: "app.lndo.site", filters: [] }],
    [
      "normalizes host:port",
      "app.lndo.site:8080",
      { hostname: "app.lndo.site", endpoint: 8080, filters: [] },
    ],
    [
      "normalizes host/path",
      "app.lndo.site/api/",
      { hostname: "app.lndo.site", pathPrefix: "/api/", filters: [] },
    ],
    [
      "normalizes combined host:port/path wildcard shorthand",
      "lets.combine.*.lndo.site:8080/everything/for-real",
      {
        hostname: "lets.combine.*.lndo.site",
        endpoint: 8080,
        pathPrefix: "/everything/for-real",
        filters: [],
      },
    ],
  ] as const)("%s", (_name, text, expected) => {
    // Given the authored shorthand above.
    // When
    const result = parseRouteShorthand(text);
    // Then
    expect(result).toEqual(Either.right(expected));
  });

  test.each(["*.app.lndo.site", "*-app.lndo.site", "wild.*.app.lndo.site", "a**b.*x*.site"])(
    "accepts leading, middle, and label-internal wildcards: %s",
    (hostname) => {
      // Given the wildcard hostname above.
      // When
      const result = parseRouteShorthand(hostname);
      // Then
      expect(result).toEqual(Either.right({ hostname, filters: [] }));
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
      expect(result).toEqual(Either.right({ ...route, filters: route.filters ?? [] }));
    },
  );

  test("leaves scheme absent for shorthand", () => {
    // Given
    const text = "app.lndo.site:443/";
    // When
    const result = parseRouteShorthand(text);
    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(Object.hasOwn(result.right, "scheme")).toBe(false);
  });

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
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RouteInputError);
        expect(result.left).toMatchObject({ key: ctx.keyPath, file: ctx.file });
        expect(result.left.message.length).toBeGreaterThan(0);
        expect(result.left.remediation.length).toBeGreaterThan(0);
      }
    },
  );

  test("uses proxy.<svc>[i] key paths for top-level proxy routes", () => {
    // Given
    const routes = ["app.lndo.site", "app:65536"];
    // When
    const result = normalizeRoutes(routes, { keyPath: "proxy.web" });
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.key).toBe("proxy.web[1]");
      expect(result.left.file).toBeUndefined();
    }
  });

  test("normalizes ordered lists including port boundaries", () => {
    // Given
    const routes = ["app:1", "app:65535"];
    // When
    const result = normalizeRoutes(routes, { keyPath: "services.web.routes" });
    // Then
    expect(result).toEqual(
      Either.right([
        { hostname: "app", endpoint: 1, filters: [] },
        { hostname: "app", endpoint: 65535, filters: [] },
      ]),
    );
  });
});
