import { describe, expect, test } from "bun:test";

import { appCommandCachePath, pluginCommandCachePath } from "../../src/cache/paths.ts";

describe("appCommandCachePath", () => {
  test("places the cache under <cacheRoot>/apps/<sanitizedName>/commands.bin", () => {
    expect(appCommandCachePath("/cache", "myapp")).toBe("/cache/apps/myapp/commands.bin");
  });

  test("falls back to 'unnamed' for empty input", () => {
    expect(appCommandCachePath("/cache", "")).toBe("/cache/apps/unnamed/commands.bin");
  });

  test("rejects all-dot names so they cannot escape the apps/<name>/ namespace", () => {
    expect(appCommandCachePath("/cache", ".")).toBe("/cache/apps/unnamed/commands.bin");
    expect(appCommandCachePath("/cache", "..")).toBe("/cache/apps/unnamed/commands.bin");
    expect(appCommandCachePath("/cache", "...")).toBe("/cache/apps/unnamed/commands.bin");
  });

  test("collapses unsafe characters to dashes and trims trailing slashes from the cache root", () => {
    expect(appCommandCachePath("/cache/", "a/b/c")).toBe("/cache/apps/a-b-c/commands.bin");
  });
});

describe("pluginCommandCachePath", () => {
  test("places the cache directly under <cacheRoot>", () => {
    expect(pluginCommandCachePath("/cache")).toBe("/cache/plugin-command-cache.bin");
  });
});
