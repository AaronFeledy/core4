import { resolve } from "node:path";
import { Predicate } from "effect";

import { describe, expect, test } from "bun:test";

const corePackagePath = resolve(import.meta.dirname, "../../package.json");

describe("@lando/core package bin", () => {
  test("pins the package executable name to lando", async () => {
    // Given: the core package manifest on disk.
    const parsed: unknown = await Bun.file(corePackagePath).json();

    // When: the bin field is read.
    const bin = Predicate.isObject(parsed) ? parsed.bin : undefined;

    // Then: the package ships exactly one executable named lando, pointing at the unchanged entry module.
    expect(bin).toEqual({ lando: "./bin/lando.ts" });
  });
});
