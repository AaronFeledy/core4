import { describe, expect, test } from "bun:test";
import type { ConfigLintViolation } from "@lando/sdk/schema";
import { mergeLintFindings } from "../src/lint.ts";

const finding = (overrides: Partial<ConfigLintViolation> = {}): ConfigLintViolation => ({
  rule: "landofile.validation",
  severity: "error",
  path: ["services", "web", "imagee"],
  message: "Expected no excess property",
  suggestion: 'Did you mean "image"?',
  source: { file: "/app/.lando.local.yml", layer: "local", path: ["services", "web", "imagee"] },
  line: 3,
  column: 5,
  scopes: ["fragment"],
  ...overrides,
});

describe("mergeLintFindings", () => {
  test("unions scopes in canonical order and preserves first-occurrence finding order", () => {
    // Given
    const first = finding({ scopes: ["effective", "effective"] });
    const second = finding({ message: "Another defect" });
    const repeated = {
      ...finding(),
      source: { path: ["services", "web", "imagee"], layer: "local" as const, file: "/app/.lando.local.yml" },
    };
    // When
    const merged = mergeLintFindings([first, second, repeated]);
    // Then
    expect(merged).toEqual([finding({ scopes: ["fragment", "effective"] }), second]);
  });

  test("is idempotent when already merged findings are merged again", () => {
    // Given
    const xs = [finding(), finding({ scopes: ["effective"] }), finding({ message: "Another defect" })];
    const merged = mergeLintFindings(xs);
    // When
    const mergedAgain = mergeLintFindings(merged);
    // Then
    expect(mergedAgain).toEqual(merged);
  });

  test("incremental merging agrees with merging the complete finding list", () => {
    // Given
    const xs = [finding(), finding({ scopes: ["effective"] }), finding({ message: "Another defect" })];
    const ys = [finding({ scopes: ["effective", "fragment"] }), finding({ message: "Third defect" })];
    // When
    const incrementallyMerged = mergeLintFindings([...mergeLintFindings(xs), ...ys]);
    // Then
    expect(incrementallyMerged).toEqual(mergeLintFindings([...xs, ...ys]));
  });

  test.each([
    { source: { file: "/app/.lando.yml", layer: "local" as const, path: ["services", "web", "imagee"] } },
    {
      source: {
        file: "/app/.lando.local.yml",
        layer: "canonical" as const,
        path: ["services", "web", "imagee"],
      },
    },
    {
      source: {
        file: "/app/.lando.local.yml",
        layer: "local" as const,
        path: ["services", "web", "image_e"],
      },
    },
    { line: 4 },
    { column: 6 },
    { path: ["services", "other", "imagee"] },
    { message: "Different defect" },
    { suggestion: "Different fix" },
    { rule: "landofile.service" },
    { severity: "warning" as const },
  ])("retains findings differing in a non-scope field: %j", (difference) => {
    // Given
    const first = finding();
    const second = finding({ ...difference, scopes: ["effective"] });
    // When
    const merged = mergeLintFindings([first, second]);
    // Then
    expect(merged).toEqual([first, second]);
  });
});
