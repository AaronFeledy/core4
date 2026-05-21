/**
 * Import-boundary contract tests.
 *
 * Required boundary checks:
 *   1. The default `@lando/core` entry MUST NOT pull `@oclif/core` into the
 *      import graph.
 *   2. `@lando/core/cli` MAY pull OCLIF (it is the programmatic-CLI entry).
 *   3. `@lando/core/oclif` is internal — exists only because the
 *      compiled-binary build needs it.
 *
 * Status: a stub harness — full Bun-bundle inspection lands when the
 * library API is more fleshed out. For now this file documents the rule
 * and asserts a placeholder.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("import boundaries", () => {
  test("can import the default entry", async () => {
    const mod = await import("../../src/index.ts");
    // The default entry exports the runtime factory + service tags.
    expect(mod).toBeDefined();
    expect(mod.makeLandoRuntime).toBeDefined();
  });

  test("can import @lando/core/services without OCLIF", async () => {
    const mod = await import("../../src/services/index.ts");
    expect(mod.ConfigService).toBeDefined();
    expect(mod.RuntimeProvider).toBeDefined();
    expect(mod.EventService).toBeDefined();
  });

  test("can import @lando/core/schema standalone", async () => {
    const mod = await import("../../src/schema/index.ts");
    expect(mod.GlobalConfig).toBeDefined();
    expect(mod.LandofileShape).toBeDefined();
  });

  test("can import @lando/core/errors standalone", async () => {
    const mod = await import("../../src/errors/index.ts");
    expect(mod.ConfigError).toBeDefined();
    expect(mod.NoProviderInstalledError).toBeDefined();
  });

  test("can import @lando/core/events standalone", async () => {
    const mod = await import("../../src/lifecycle/index.ts");
    expect(mod.PreStartEvent).toBeDefined();
    expect(mod.PostStartEvent).toBeDefined();
    expect(mod.SubscriberPriority).toBeDefined();
  });

  test("marks the Alpha library API as unstable/dev-channel only", async () => {
    const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("unstable");
    expect(source).toContain("dev/next channels");
  });

  // TODO: static-analyze the resolved import graph for the default
  // entry and assert that `@oclif/core` is not transitively reachable.
});
