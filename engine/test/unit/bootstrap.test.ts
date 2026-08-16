/**
 * Bootstrap-level ranking and ordering.
 */
import { describe, expect, test } from "bun:test";

import { BOOTSTRAP_RANK, isAtLeast } from "../../src/runtime/bootstrap.ts";

describe("BootstrapLevel ranking", () => {
  test("strictly orders levels from none → app", () => {
    expect(BOOTSTRAP_RANK.none).toBeLessThan(BOOTSTRAP_RANK.minimal);
    expect(BOOTSTRAP_RANK.minimal).toBeLessThan(BOOTSTRAP_RANK.plugins);
    expect(BOOTSTRAP_RANK.plugins).toBeLessThan(BOOTSTRAP_RANK.commands);
    expect(BOOTSTRAP_RANK.commands).toBeLessThan(BOOTSTRAP_RANK.tooling);
    expect(BOOTSTRAP_RANK.tooling).toBeLessThan(BOOTSTRAP_RANK.provider);
    expect(BOOTSTRAP_RANK.provider).toBeLessThan(BOOTSTRAP_RANK.global);
    expect(BOOTSTRAP_RANK.global).toBeLessThan(BOOTSTRAP_RANK.scratch);
    expect(BOOTSTRAP_RANK.scratch).toBeLessThan(BOOTSTRAP_RANK.app);
    expect(BOOTSTRAP_RANK.provider).toBeLessThan(BOOTSTRAP_RANK.app);
  });

  test("isAtLeast comparisons", () => {
    expect(isAtLeast("minimal", "none")).toBe(true);
    expect(isAtLeast("none", "minimal")).toBe(false);
    expect(isAtLeast("app", "provider")).toBe(true);
    expect(isAtLeast("provider", "app")).toBe(false);
    expect(isAtLeast("commands", "commands")).toBe(true);
    expect(isAtLeast("minimal", "tooling")).toBe(false);
  });
});
