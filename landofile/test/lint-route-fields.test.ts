import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeViolations } from "@lando/landofile/lint";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { lintLandofile } from "../src/lint.ts";

describe("static route field lint", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-lint-route-fields-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reports every invalid route with its original index and field", async () => {
    // Given
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: route-fields",
        "services:",
        "  web:",
        "    routes:",
        "      - hostname: app.site:8080",
        "      - app.site",
        "      - hostname: app.site",
        "        pathPrefix: nope",
        "proxy:",
        "  api:",
        "    - api.site",
        "    - hostname: api.site/path",
        "",
      ].join("\n"),
    );
    // When
    const result = await Effect.runPromise(lintLandofile({ cwd: root }));
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ path }) => path)).toEqual([
      ["services", "web", "routes", 0, "hostname"],
      ["services", "web", "routes", 2, "pathPrefix"],
      ["proxy", "api", 1, "hostname"],
    ]);
    expect(result.violations[0]?.suggestion).toMatch(/endpoint.*pathPrefix/);
  });

  test("reports both invalid fields of one object route", () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      services: { web: { routes: [{ hostname: "app.site:8080/api", pathPrefix: "api" }] } },
    });
    // When
    const violations = routeViolations(landofile, { deferExpressions: false });
    // Then
    expect(violations.map(({ path }) => path)).toEqual([
      ["services", "web", "routes", 0, "hostname"],
      ["services", "web", "routes", 0, "pathPrefix"],
    ]);
  });

  test.each([
    '"{{ app.name }}.lndo.site/x"',
    'hostname: "{{ app.name }}.lndo.site"',
    'hostname: app.site\n        pathPrefix: "{{ app.path }}"',
  ])("defers expression-bearing route %s", async (route) => {
    // Given
    await writeFile(
      join(root, ".lando.yml"),
      `name: routes\nservices:\n  web:\n    routes:\n      - ${route}\n`,
    );
    // When
    const result = await Effect.runPromise(lintLandofile({ cwd: root }));
    // Then
    expect(result).toMatchObject({ valid: true, violations: [] });
  });

  test("does not defer invalid hostnames because a filter contains an expression", () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "routes",
      services: {
        web: {
          routes: [
            {
              hostname: "app.site:80",
              filters: [{ type: "requestHeader", header: "X-Test", value: "{{ app.name }}" }],
            },
          ],
        },
      },
    });
    // When
    const violations = routeViolations(landofile, { deferExpressions: true });
    // Then
    expect(violations.map(({ path }) => path)).toEqual([["services", "web", "routes", 0, "hostname"]]);
  });

  test.each([
    "${ROUTE_HOST}/x",
    { hostname: "${ROUTE_HOST}" },
    { hostname: "app.site", pathPrefix: "${ROUTE_PATH}" },
  ])("defers shell-style expression text at the route helper boundary: %j", (route) => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({ services: { web: { routes: [route] } } });
    // When
    const violations = routeViolations(landofile, { deferExpressions: true });
    // Then
    expect(violations).toEqual([]);
  });
});
