import { describe, expect, test } from "bun:test";

/**
 * Test doubles and helpers the `@lando/core/testing` subpath publishes to
 * embedding hosts. Removing one is a breaking change for that surface.
 */
const TESTING_EXPORTS = [
  "ScenarioContext",
  "TestDataMover",
  "TestDataset",
  "TestRemoteSource",
  "TestRuntimeProvider",
  "TestSecretStore",
  "TestTunnelService",
  "makeTestRuntime",
  "makeTestStateStore",
  "provideTestRuntime",
  "withScenarioContext",
] as const;

describe("@lando/core/testing surface", () => {
  test("publishes the documented test doubles and runtime helpers", async () => {
    // Given/When: the testing subpath is loaded through its entry point.
    const testing: Readonly<Record<string, unknown>> = await import("../../src/testing/index.ts");

    // Then: every advertised export is present.
    const missing = TESTING_EXPORTS.filter((name) => testing[name] === undefined);
    expect(missing).toEqual([]);
  });
});
