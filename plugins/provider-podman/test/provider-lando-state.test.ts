import { describe, expect, test } from "bun:test";

import { providerLandoSetupStatePath } from "../src/provider-lando-state.ts";

describe("provider-lando setup state path", () => {
  test("appends the exact provider-lando setup-state suffix", () => {
    // Given
    const stateDir = "/tmp/lando/providers";

    // When
    const result = providerLandoSetupStatePath(stateDir);

    // Then
    expect(result).toBe("/tmp/lando/providers/provider-lando/setup-state.json");
  });

  test("normalizes trailing slashes before appending the suffix", () => {
    // Given
    const stateDir = "/tmp/lando/providers///";

    // When
    const result = providerLandoSetupStatePath(stateDir);

    // Then
    expect(result).toBe("/tmp/lando/providers/provider-lando/setup-state.json");
  });
});
