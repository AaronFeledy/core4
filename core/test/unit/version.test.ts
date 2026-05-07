/**
 * Smoke test for the `version` command operation.
 *
 * This test exercises the most trivial built-in operation to verify Effect
 * runs cleanly through the workspace.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { version } from "../../src/cli/commands/version.ts";

describe("version", () => {
  test("returns the current core + bun versions", async () => {
    const result = await Effect.runPromise(version);

    expect(result.core).toBeDefined();
    expect(result.bun).toMatch(/^\d+\.\d+/);
    expect(["darwin", "linux", "win32"]).toContain(result.platform);
  });
});
