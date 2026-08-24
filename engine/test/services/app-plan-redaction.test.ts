import { describe, expect, test } from "bun:test";

import {
  collectAppPlanRedactionTokens,
  collectLandofileRedactionTokens,
} from "../../src/services/app-plan-redaction.ts";

describe("app-plan redaction tokens", () => {
  test("includes secret service environment values from an app plan", () => {
    // Given
    const canary = "env-file-json-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: { DB_PASSWORD: canary },
        },
      },
    });

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes authored landofile environment values", () => {
    // Given
    const canary = "config-canary";
    const landofile = {
      services: {
        app: {
          environment: { PASSWORD: canary },
        },
      },
    };

    // When
    const tokens = collectLandofileRedactionTokens(landofile);

    // Then
    expect(tokens).toContain(canary);
  });
});
