import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const corePackagePath = resolve(import.meta.dirname, "../../package.json");

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("@lando/core package bin", () => {
  test("pins the npm executable name to lando4", async () => {
    // Given: the core package manifest on disk.
    const parsed: unknown = await Bun.file(corePackagePath).json();

    // When: the bin field is read.
    const bin = isJsonObject(parsed) ? parsed.bin : undefined;

    // Then: Alpha/Beta ships exactly one executable named lando4, pointing at the unchanged entry module.
    expect(bin).toEqual({ lando4: "./bin/lando.ts" });
  });
});
