import { describe, expect, test } from "bun:test";
import {
  parseRouteHostname,
  parseRoutePathPrefix,
  parseRouteShorthand,
  routeInputKey,
  routeInputObject,
} from "@lando/sdk/landofile";
import { Result } from "effect";

test("keeps long template source keyed without applying concrete DNS length limits", () => {
  // Given
  const hostname = `{{ env.${"A".repeat(64)} }}.site`;
  // When
  const route = routeInputObject(`${hostname}:8080/api`);
  // Then
  expect(route).toEqual({ hostname, endpoint: 8080, pathPrefix: "/api" });
  expect(routeInputKey(`${hostname}:8080/api`)).toBe(routeInputKey({ hostname, pathPrefix: "/api" }));
  expect(routeInputKey(route)).toBeDefined();
});

describe("concrete route hostname", () => {
  test.each(["app.lndo.site", "*.app.site", "*-app.site", "wild.*.app.site", "a**b.*x*.site", "APP-1"])(
    "preserves valid host pattern %s",
    (text) => {
      // Given the concrete hostname above.
      // When
      const result = parseRouteHostname(text);
      // Then
      expect(result).toEqual(Result.succeed(text));
    },
  );

  test.each([
    "",
    "a b",
    "app.site:8080/api",
    "app.site:8080",
    "app.site/api",
    "https://app.site",
    "api..site",
    ".app.site",
    "app.site.",
    "-app.site",
    "app-.site",
    "app_site",
    "app?x",
    "app#x",
    "{{app.name}}",
    "${HOST}",
  ])("rejects invalid or unevaluated hostname %j", (text) => {
    // Given the invalid concrete value above.
    // When
    const result = parseRouteHostname(text);
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toContain(JSON.stringify(text));
  });

  test("directs scheme prefixes to the scheme field", () => {
    // Given
    const text = "https://app.site";
    // When
    const result = parseRouteHostname(text);
    // Then
    expect(Result.isFailure(result) && result.failure).toContain("scheme");
  });
});

describe("concrete route path prefix", () => {
  test.each(["/", "/api", "/api/", "/a-b/c%20d", "/a:b"])("preserves path %s", (text) => {
    // Given the concrete path above.
    // When
    const result = parseRoutePathPrefix(text);
    // Then
    expect(result).toEqual(Result.succeed(text));
    expect(parseRouteShorthand(`app.site${text}`)).toEqual(
      Result.succeed({ hostname: "app.site", pathPrefix: text }),
    );
  });

  test.each(["", "nope", "/a b", "/a\tb", "/a?x", "/a#x", "{{ app.path }}", "${PATH}"])(
    "rejects invalid path %j",
    (text) => {
      // Given the invalid concrete path above.
      // When
      const result = parseRoutePathPrefix(text);
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toContain(JSON.stringify(text));
    },
  );
});
