import { describe, expect, test } from "bun:test";

import { renderConfigWriteResult } from "../../../src/cli/commands/config-write-render.ts";

describe("config write rendering", () => {
  test.each([
    ["text", "abc", '"abc" (text)'],
    ["number", 8080, "8080 (number)"],
    ["boolean", true, "true (boolean)"],
    ["null", null, "null (null)"],
    ["list", ["one"], '["one"] (list)'],
    ["map", { one: 1 }, '{"one":1} (map)'],
  ])("shows value and kind for %s", (_kind, value, expected) => {
    // Given
    const input = { file: "/f", subcommand: "set", key: "k", value, editSavedLabel: "config" };
    // When
    const result = renderConfigWriteResult(input);
    // Then
    expect(result).toBe(`/f: set k = ${expected}.`);
  });

  test.each([
    ["tracing.otlp.headers.Authorization", "Bearer secret-token-1608"],
    ["tracing.otlp.headers", { "X-Auth": "secret-token-1608" }],
    ["appEnv.API_TOKEN", "secret-token-1608"],
  ])("redacts secret values at %s before formatting", (key, value) => {
    // Given
    const input = { file: "/f", subcommand: "set", key, value, editSavedLabel: "config" };
    // When
    const result = renderConfigWriteResult(input);
    // Then
    expect(result).not.toContain("secret-token-1608");
    expect(result).toContain("[redacted]");
  });

  test("escapes terminal control bytes and bounds long values", () => {
    // Given
    const value = `\u001b[31m\n${"x".repeat(1000)}`;
    // When
    const result = renderConfigWriteResult({
      file: "/f",
      subcommand: "set",
      key: "k",
      value,
      editSavedLabel: "config",
    });
    // Then
    expect(result).not.toContain("\u001b");
    expect(result).not.toContain("\n");
    expect(result?.length).toBeLessThan(200);
    expect(result).toContain("...");
  });
  test.each([
    {
      subcommand: "set",
      dryRun: true,
      changed: true,
      expected: "/f: would set k = 8080 (number) (dry run).",
    },
    { subcommand: "set", dryRun: false, changed: true, expected: "/f: set k = 8080 (number)." },
    {
      subcommand: "set",
      dryRun: true,
      changed: false,
      expected: "/f: k is already set to 8080 (number) (no change).",
    },
    {
      subcommand: "set",
      dryRun: false,
      changed: false,
      expected: "/f: k is already set to 8080 (number) (no change).",
    },
    { subcommand: "unset", dryRun: true, changed: false, expected: "/f: k was not present (no change)." },
    { subcommand: "unset", dryRun: false, changed: false, expected: "/f: k was not present (no change)." },
    { subcommand: "unset", dryRun: true, changed: true, expected: "/f: would unset k (dry run)." },
    { subcommand: "unset", dryRun: false, changed: true, expected: "/f: unset k." },
    {
      subcommand: "edit",
      dryRun: true,
      changed: true,
      expected: "/f: would save edited Landofile (dry run).",
    },
    { subcommand: "edit", dryRun: false, changed: true, expected: "/f: saved edited Landofile." },
    {
      subcommand: "edit",
      dryRun: true,
      changed: false,
      expected: "/f: no edits made to Landofile (no change).",
    },
    {
      subcommand: "edit",
      dryRun: false,
      changed: false,
      expected: "/f: no edits made to Landofile (no change).",
    },
    { subcommand: "validate", dryRun: false, changed: false, expected: "/f: valid." },
    { subcommand: "view", dryRun: false, changed: false, expected: undefined },
  ])("renders $subcommand (dryRun=$dryRun, changed=$changed)", ({ expected, ...input }) => {
    // Given
    const options = { ...input, file: "/f", key: "k", value: 8080, editSavedLabel: "Landofile" };
    // When
    const result = renderConfigWriteResult(options);
    // Then
    expect(result).toBe(expected);
  });

  test.each([
    { editSavedLabel: "config", expected: "/f: saved edited config." },
    { editSavedLabel: "global-app Landofile", expected: "/f: saved edited global-app Landofile." },
  ])("preserves the $editSavedLabel edit label", ({ editSavedLabel, expected }) => {
    // Given
    const input = { file: "/f", subcommand: "edit", editSavedLabel };
    // When
    const result = renderConfigWriteResult(input);
    // Then
    expect(result).toBe(expected);
  });

  test.each([
    { editSavedLabel: "config", expected: "/f: no edits made to config (no change)." },
    {
      editSavedLabel: "global-app Landofile",
      expected: "/f: no edits made to global-app Landofile (no change).",
    },
  ])("names the $editSavedLabel surface when the editor made no edits", ({ editSavedLabel, expected }) => {
    // Given
    const input = { file: "/f", subcommand: "edit", changed: false, editSavedLabel };
    // When
    const result = renderConfigWriteResult(input);
    // Then
    expect(result).toBe(expected);
  });

  test.each([
    ["tracing.otlp.headers.Authorization", "Bearer secret-token-1608"],
    ["tracing.otlp.headers", { "X-Auth": "secret-token-1608" }],
    ["appEnv.API_TOKEN", "secret-token-1608"],
  ])("redacts the already-set value at %s", (key, value) => {
    // Given
    const input = { file: "/f", subcommand: "set", key, value, changed: false, editSavedLabel: "config" };
    // When
    const result = renderConfigWriteResult(input);
    // Then
    expect(result).not.toContain("secret-token-1608");
    expect(result).toContain("[redacted]");
    expect(result).toEndWith("(no change).");
  });

  test("escapes terminal control bytes and bounds a long already-set value", () => {
    // Given
    const value = `\u001b[31m\n${"x".repeat(1000)}`;
    // When
    const result = renderConfigWriteResult({
      file: "/f",
      subcommand: "set",
      key: "k",
      value,
      changed: false,
      editSavedLabel: "config",
    });
    // Then
    expect(result).not.toContain("\u001b");
    expect(result).not.toContain("\n");
    expect(result?.length).toBeLessThan(220);
    expect(result).toContain("...");
    expect(result).toEndWith("(text) (no change).");
  });
});
