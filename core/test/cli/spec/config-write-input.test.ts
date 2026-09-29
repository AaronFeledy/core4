import { expect, test } from "bun:test";
import { configWriteOptionsFromInput } from "../../../src/cli/command-specs/config-write-input";

test("retains write inputs when strings and a supported type are provided", () => {
  const input = {
    args: { subcommand: "unknown", key: "", value: "" },
    flags: { type: "yaml", format: "yaml", path: "a.b", editor: "vim", "dry-run": true },
  };
  const result = configWriteOptionsFromInput(input, { formats: ["json", "yaml", "table"] });
  expect(result).toEqual({
    subcommand: "unknown",
    key: "",
    value: "",
    type: "yaml",
    format: "yaml",
    path: "a.b",
    editor: "vim",
    dryRun: true,
  });
});

test("omits unsupported fields when values do not match their input contracts", () => {
  const input = {
    args: { subcommand: "", key: 1, value: false },
    flags: { type: "xml", format: "yaml", path: 1, editor: false, "dry-run": "true" },
  };
  const result = configWriteOptionsFromInput(input, { formats: ["json", "table"] });
  expect(result).toEqual({});
});

test("uses the explicit default when the format is unsupported", () => {
  const input = { flags: { format: "yaml" } };
  const result = configWriteOptionsFromInput(input, { formats: ["json", "table"], defaultFormat: "table" });
  expect(result).toEqual({ format: "table" });
});
