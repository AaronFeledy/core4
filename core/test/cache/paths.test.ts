import { describe, expect, test } from "bun:test";

import {
  appCommandCachePath,
  appToolingCompilationCachePath,
  pluginCommandCachePath,
} from "../../src/cache/paths.ts";

describe("appCommandCachePath", () => {
  test("places the cache under a same-name-safe app directory", () => {
    expect(appCommandCachePath("/cache", "myapp", "/apps/myapp")).toMatch(
      /^\/cache\/apps\/myapp-[a-f0-9]{12}\/commands\.bin$/u,
    );
  });

  test("falls back to 'unnamed' for empty input", () => {
    expect(appCommandCachePath("/cache", "", "/apps/unnamed")).toMatch(
      /^\/cache\/apps\/unnamed-[a-f0-9]{12}\/commands\.bin$/u,
    );
  });

  test("rejects all-dot names so they cannot escape the apps/<name>/ namespace", () => {
    expect(appCommandCachePath("/cache", ".", "/apps/dot")).toMatch(
      /^\/cache\/apps\/unnamed-[a-f0-9]{12}\/commands\.bin$/u,
    );
    expect(appCommandCachePath("/cache", "..", "/apps/dotdot")).toMatch(
      /^\/cache\/apps\/unnamed-[a-f0-9]{12}\/commands\.bin$/u,
    );
    expect(appCommandCachePath("/cache", "...", "/apps/dotdotdot")).toMatch(
      /^\/cache\/apps\/unnamed-[a-f0-9]{12}\/commands\.bin$/u,
    );
  });

  test("collapses unsafe characters to dashes and trims trailing slashes from the cache root", () => {
    expect(appCommandCachePath("/cache/", "a/b/c", "/apps/a-b-c")).toMatch(
      /^\/cache\/apps\/a-b-c-[a-f0-9]{12}\/commands\.bin$/u,
    );
  });

  test("separates projects with the same app name in different roots", () => {
    expect(appCommandCachePath("/cache", "same", "/apps/one")).not.toBe(
      appCommandCachePath("/cache", "same", "/apps/two"),
    );
  });
});

describe("pluginCommandCachePath", () => {
  test("places the cache directly under <cacheRoot>", () => {
    expect(pluginCommandCachePath("/cache")).toBe("/cache/plugin-command-cache.bin");
  });
});

describe("appToolingCompilationCachePath", () => {
  test("keys the tooling cache by app root without needing the app name", () => {
    expect(appToolingCompilationCachePath("/cache", "/apps/myapp")).toMatch(
      /^\/cache\/apps\/tooling-[a-f0-9]{12}\/commands\.bin$/u,
    );
  });
});
