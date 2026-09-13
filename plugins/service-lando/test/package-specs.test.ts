import { describe, expect, test } from "bun:test";

import {
  normalizeComposerPackages,
  normalizeNpmGlobals,
  shellSingleQuote,
} from "../src/services/_package-specs.ts";

describe("normalizeNpmGlobals", () => {
  test("sorts authored packages by name so authoring order cannot change identity", () => {
    // Given the same globals authored in two different orders,
    // when normalized,
    // then both produce the identical ordered entry list.
    const forward = normalizeNpmGlobals({ yarn: "1.22.4", "gulp-cli": "latest" });
    const reversed = normalizeNpmGlobals({ "gulp-cli": "latest", yarn: "1.22.4" });

    expect(forward).toEqual([
      ["gulp-cli", "latest"],
      ["yarn", "1.22.4"],
    ]);
    expect(reversed).toEqual(forward);
  });

  test("accepts scoped names and the npm specifiers real projects use", () => {
    // Given scoped packages and dist-tag, range, and wildcard specifiers,
    // when normalized,
    // then each is preserved.
    expect(
      normalizeNpmGlobals({
        "@angular/cli": "^17.0.0",
        pnpm: "latest-10",
        typescript: ">=5 <6",
        turbo: "*",
      }),
    ).toEqual([
      ["@angular/cli", "^17.0.0"],
      ["pnpm", "latest-10"],
      ["turbo", "*"],
      ["typescript", ">=5 <6"],
    ]);
  });

  test("returns no entries for an absent or empty map", () => {
    expect(normalizeNpmGlobals(undefined)).toEqual([]);
    expect(normalizeNpmGlobals({})).toEqual([]);
  });

  test("rejects an unsafe package name with remediation naming the package", () => {
    expect(() => normalizeNpmGlobals({ "../escape": "1.0.0" })).toThrow(
      /Unsupported npm package "\.\.\/escape"/,
    );
    expect(() => normalizeNpmGlobals({ "Yarn Classic": "1" })).toThrow(/Unsupported npm package/);
    expect(() => normalizeNpmGlobals({ [`${"a".repeat(215)}`]: "1" })).toThrow(/Unsupported npm package/);
  });

  test("rejects an unsafe version specifier, including a secret reference", () => {
    expect(() => normalizeNpmGlobals({ yarn: "${secret:NPM_TOKEN}" })).toThrow(
      /Unsupported npm version specifier .* for "yarn"/,
    );
    expect(() => normalizeNpmGlobals({ yarn: "1; rm -rf /" })).toThrow(/Unsupported npm version specifier/);
    expect(() => normalizeNpmGlobals({ yarn: "" })).toThrow(/Unsupported npm version specifier/);
  });

  test("rejects a non-object globals value", () => {
    expect(() => normalizeNpmGlobals("yarn")).toThrow(/Unsupported npm globals/);
  });
});

describe("normalizeComposerPackages", () => {
  test("sorts authored packages by name so authoring order cannot change identity", () => {
    const forward = normalizeComposerPackages({
      "squizlabs/php_codesniffer": "^3.10",
      "phpstan/phpstan": "^1.11",
    });
    const reversed = normalizeComposerPackages({
      "phpstan/phpstan": "^1.11",
      "squizlabs/php_codesniffer": "^3.10",
    });

    expect(forward).toEqual([
      ["phpstan/phpstan", "^1.11"],
      ["squizlabs/php_codesniffer", "^3.10"],
    ]);
    expect(reversed).toEqual(forward);
  });

  test("accepts the constraint spellings Composer supports", () => {
    expect(
      normalizeComposerPackages({
        "drush/drush": "13.0.0",
        "vendor/a": "^1.0 || ^2.0",
        "vendor/b": ">=1.0,<2.0",
        "vendor/c": "dev-main@dev",
      }),
    ).toEqual([
      ["drush/drush", "13.0.0"],
      ["vendor/a", "^1.0 || ^2.0"],
      ["vendor/b", ">=1.0,<2.0"],
      ["vendor/c", "dev-main@dev"],
    ]);
  });

  test("returns no entries for an absent or empty map", () => {
    expect(normalizeComposerPackages(undefined)).toEqual([]);
    expect(normalizeComposerPackages({})).toEqual([]);
  });

  test("rejects a package name that is not vendor/name", () => {
    expect(() => normalizeComposerPackages({ drush: "13.0.0" })).toThrow(
      /Unsupported Composer package "drush"/,
    );
    expect(() => normalizeComposerPackages({ "Vendor/Tool": "1" })).toThrow(/Unsupported Composer package/);
  });

  test("rejects an unsafe constraint, including a secret reference", () => {
    expect(() => normalizeComposerPackages({ "vendor/a": "${secret:TOKEN}" })).toThrow(
      /Unsupported Composer version constraint .* for "vendor\/a"/,
    );
    expect(() => normalizeComposerPackages({ "vendor/a": "1`id`" })).toThrow(
      /Unsupported Composer version constraint/,
    );
  });

  test("rejects a non-object packages value", () => {
    expect(() => normalizeComposerPackages(["vendor/a"])).toThrow(/Unsupported Composer packages/);
  });
});

describe("shellSingleQuote", () => {
  test("wraps a validated token in single quotes", () => {
    expect(shellSingleQuote("vendor/a:^1.0 || ^2.0")).toBe("'vendor/a:^1.0 || ^2.0'");
  });

  test("refuses a token carrying a single quote", () => {
    expect(() => shellSingleQuote("a'b")).toThrow(/cannot be quoted safely/);
  });
});
