import { expect, test } from "bun:test";
import { canonicalImageReference, sameImageReference } from "@lando/sdk/schema";

test.each([
  ["php", "docker.io/library/php:latest"],
  ["library/php", "docker.io/library/php:latest"],
  ["docker.io/php:8.3", "docker.io/library/php:8.3"],
  ["index.docker.io/library/php:RC", "docker.io/library/php:RC"],
  ["registry-1.docker.io/team/php", "docker.io/team/php:latest"],
  ["team/php", "docker.io/team/php:latest"],
  ["php@sha256:abcd", "docker.io/library/php@sha256:abcd"],
  ["php:RC@sha256:abcd", "docker.io/library/php:RC@sha256:abcd"],
  ["registry.example:5000/php", "registry.example:5000/php:latest"],
  ["docker.io:5000/php", "docker.io:5000/php:latest"],
  ["ghcr.io/team/php:RC", "ghcr.io/team/php:RC"],
  ["localhost/php", "localhost/php:latest"],
  ["localhost:5000/team/php@sha256:abcd", "localhost:5000/team/php@sha256:abcd"],
])("canonicalizes %s without changing image identity", (input, expected) => {
  const result = canonicalImageReference(input);
  expect(result).toBe(expected);
});

test.each([
  ["php", "index.docker.io/library/php:latest", true],
  ["php:RC", "php:rc", false],
  ["ghcr.io/php", "php", false],
  ["php@sha256:abcd", "php@sha256:efgh", false],
  ["localhost/php", "php", false],
])("compares %s and %s by canonical image identity", (left, right, expected) => {
  const result = sameImageReference(left, right);
  expect(result).toBe(expected);
});
