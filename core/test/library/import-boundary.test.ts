import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("import boundaries", () => {
  test("can import the default entry", async () => {
    const mod = await import("../../src/index.ts");
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
});
