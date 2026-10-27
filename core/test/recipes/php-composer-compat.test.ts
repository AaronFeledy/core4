import { describe, expect, test } from "bun:test";

import { composerOption } from "../../src/recipes/builtin/source-php.ts";
const DRUPAL_COMPOSER_OPTIONS = composerOption.type.values;
const COMPOSER_OPTIONS = [...DRUPAL_COMPOSER_OPTIONS, false];
import { composerChoicesForPhp } from "../../src/recipes/php-composer-compat.ts";

describe("composerChoicesForPhp", () => {
  test("restricts PHP 8.5 lamp choices to major 2 and false", () => {
    expect(composerChoicesForPhp("8.5", COMPOSER_OPTIONS)).toEqual(["2", false]);
  });

  test("restricts PHP 8.5 Drupal choices to major 2", () => {
    expect(composerChoicesForPhp("8.5", DRUPAL_COMPOSER_OPTIONS)).toEqual(["2"]);
  });

  test("keeps Composer 2.7.7 for PHP 8.4", () => {
    expect(composerChoicesForPhp("8.4", COMPOSER_OPTIONS)).toContain("2.7.7");
  });

  test("keeps Composer 2.7.7 for PHP 8.1", () => {
    expect(composerChoicesForPhp("8.1", COMPOSER_OPTIONS)).toContain("2.7.7");
  });
});
