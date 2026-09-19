import { expect, test } from "bun:test";
import type { ConfigResult } from "@lando/engine/operations/config";
import { yamlRoundTripRecord } from "@lando/sdk/test";

import { renderConfigResult } from "../../src/cli/commands/config.ts";

const yamlGet = (value: unknown): ConfigResult => ({
  subcommand: "get",
  format: "yaml",
  value,
});

test("config yaml output round-trips a record root through Bun.YAML.parse", () => {
  // Given
  const value = {
    DB_PASSWORD: "[redacted]",
    colon: "a: b",
    star: "*anchor",
    ...yamlRoundTripRecord(),
  };
  // When
  const rendered = renderConfigResult(yamlGet(value));
  // Then
  expect(Bun.YAML.parse(rendered)).toEqual(value);
});

test("config yaml output round-trips a scalar root", () => {
  // Given / When / Then
  expect(Bun.YAML.parse(renderConfigResult(yamlGet("True")))).toBe("True");
  expect(Bun.YAML.parse(renderConfigResult(yamlGet("a: b")))).toBe("a: b");
});

test("config yaml output round-trips an array root", () => {
  // Given
  const value = ["True", "8080:80", 1, null];
  // When
  const rendered = renderConfigResult(yamlGet(value));
  // Then
  expect(Bun.YAML.parse(rendered)).toEqual(value);
});

test("dotted config keys stay plain and ambiguous keys are quoted", () => {
  // Given
  const value = {
    "telemetry.enabled": true,
    "com.example.password": "secret",
    "dev.example.db-password": "secret",
    yes: "y",
  };
  // When
  const rendered = renderConfigResult(yamlGet(value));
  // Then
  expect(rendered).toContain("telemetry.enabled:");
  expect(rendered).toContain('"yes":');
});
