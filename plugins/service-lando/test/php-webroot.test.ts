import { describe, expect, test } from "bun:test";

import { FRAMEWORK_WEBROOTS, SUPPORTED_PHP_FRAMEWORKS, frameworkWebrootPath } from "../src/services/php.ts";

describe("frameworkWebrootPath — single source of truth parity", () => {
  test("derives same absolute path as inline ternary for every framework", () => {
    for (const framework of SUPPORTED_PHP_FRAMEWORKS) {
      const rel = FRAMEWORK_WEBROOTS[framework];
      const expected = rel === "" ? "/app" : `/app/${rel}`;
      expect(frameworkWebrootPath(framework)).toBe(expected);
    }
  });

  test("returns /app for frameworks with empty relative webroot (none, wordpress)", () => {
    expect(frameworkWebrootPath("none")).toBe("/app");
    expect(frameworkWebrootPath("wordpress")).toBe("/app");
  });

  test("returns /app/web for drupal", () => {
    expect(frameworkWebrootPath("drupal")).toBe("/app/web");
  });

  test("returns /app/public for laravel and symfony", () => {
    expect(frameworkWebrootPath("laravel")).toBe("/app/public");
    expect(frameworkWebrootPath("symfony")).toBe("/app/public");
  });

  test("every result starts with /app for all frameworks", () => {
    for (const framework of SUPPORTED_PHP_FRAMEWORKS) {
      expect(frameworkWebrootPath(framework)).toMatch(/^\/app(\/|$)/);
    }
  });
});
