import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  PHP_COMMON_EXTENSIONS,
  PHP_COMPOSER,
} from "../../../plugins/service-lando/src/services/php-prerequisites.ts";
import { SUPPORTED_PHP_VERSIONS } from "../../../plugins/service-lando/src/services/php.ts";
import { renderPhpBaseDockerfile } from "../../../scripts/build-php-base-images.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("PHP base image definitions", () => {
  test("committed Dockerfiles match the shared prerequisite renderer", async () => {
    for (const version of SUPPORTED_PHP_VERSIONS) {
      const path = resolve(repoRoot, "images/php", version, "Dockerfile");
      expect(await Bun.file(path).text()).toBe(renderPhpBaseDockerfile(version));
    }
  });

  test("carry exact Composer identity and every promised extension", () => {
    const dockerfile = renderPhpBaseDockerfile("8.2");

    expect(dockerfile).toContain(PHP_COMPOSER.version);
    expect(dockerfile).toContain(PHP_COMPOSER.sha256);
    for (const extension of PHP_COMMON_EXTENSIONS) expect(dockerfile).toContain(extension);
  });
});
