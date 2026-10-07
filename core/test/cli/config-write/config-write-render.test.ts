import { describe, expect, test } from "bun:test";

import { renderConfigWriteResult } from "../../../src/cli/commands/config-write-render.ts";

describe("config write rendering", () => {
  test.each([
    { subcommand: "set", dryRun: true, changed: true, expected: "/f: would set k (dry run)." },
    { subcommand: "set", dryRun: false, changed: true, expected: "/f: set k." },
    { subcommand: "unset", dryRun: true, changed: false, expected: "/f: k was not present (no change)." },
    { subcommand: "unset", dryRun: true, changed: true, expected: "/f: would unset k (dry run)." },
    { subcommand: "unset", dryRun: false, changed: true, expected: "/f: unset k." },
    { subcommand: "edit", dryRun: false, changed: true, expected: "/f: saved edited Landofile." },
    { subcommand: "validate", dryRun: false, changed: false, expected: "/f: valid." },
    { subcommand: "view", dryRun: false, changed: false, expected: undefined },
  ])("renders $subcommand (dryRun=$dryRun, changed=$changed)", ({ expected, ...input }) => {
    // Given
    const options = { ...input, file: "/f", key: "k", editSavedLabel: "Landofile" };
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
});
