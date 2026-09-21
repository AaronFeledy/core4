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

  test("includes secret global app defaults after planner projection", () => {
    const canary = "global-app-default-canary";

    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: { API_TOKEN: canary },
        },
      },
    });

    expect(tokens).toContain(canary);
  });

  test("includes secret effective service label values from an app plan", () => {
    // Given
    const canary = "effective-label-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: {},
          extensions: { compose: { labels: { "com.example.api-token": canary } } },
        },
      },
    });

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes dotted secret label values while keeping non-secret labels visible", () => {
    // Given
    const dotted = "dotted-effective-label-canary";
    const hyphenated = "hyphenated-effective-label-canary";
    const visible = "dotted-visible-label-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: {},
          extensions: {
            compose: {
              labels: {
                "com.example.password": dotted,
                "dev.example.db-password": hyphenated,
                "com.example.team": visible,
              },
            },
          },
        },
      },
    });

    // Then
    expect(tokens).toContain(dotted);
    expect(tokens).toContain(hyphenated);
    expect(tokens).not.toContain(visible);
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

  test("includes dotted secret landofile label values while keeping non-secret labels visible", () => {
    // Given
    const dotted = "dotted-landofile-label-canary";
    const hyphenated = "hyphenated-landofile-label-canary";
    const visible = "dotted-visible-landofile-label-canary";

    // When
    const tokens = collectLandofileRedactionTokens({
      services: {
        app: {
          environment: {},
          labels: {
            "com.example.password": dotted,
            "dev.example.db-password": hyphenated,
            "com.example.team": visible,
          },
        },
      },
    });

    // Then
    expect(tokens).toContain(dotted);
    expect(tokens).toContain(hyphenated);
    expect(tokens).not.toContain(visible);
  });
});
