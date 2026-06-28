import { describe, expect, test } from "bun:test";

import { RendererSelectionError } from "@lando/sdk/errors";

import {
  DEFAULT_RESULT_FORMAT,
  RESULT_FORMATS,
  extractFormatFlags,
  isResultFormat,
  resolveResultFormat,
  universalFormatFlagDefs,
} from "../../src/cli/format-flags.ts";

describe("format-flags constants", () => {
  test("RESULT_FORMATS lists supported command result formats", () => {
    expect(RESULT_FORMATS).toEqual(["text", "json", "table", "yaml", "ndjson"]);
  });

  test("DEFAULT_RESULT_FORMAT is text", () => {
    expect(DEFAULT_RESULT_FORMAT).toBe("text");
  });

  test("isResultFormat accepts supported values only", () => {
    expect(isResultFormat("text")).toBe(true);
    expect(isResultFormat("json")).toBe(true);
    expect(isResultFormat("table")).toBe(true);
    expect(isResultFormat("yaml")).toBe(true);
    expect(isResultFormat("ndjson")).toBe(true);
    expect(isResultFormat("")).toBe(false);
    expect(isResultFormat("JSON")).toBe(false);
    expect(isResultFormat("xml")).toBe(false);
  });

  test("universalFormatFlagDefs exposes format plus json shortcut definitions", () => {
    expect(universalFormatFlagDefs.format.type).toBe("option");
    expect(universalFormatFlagDefs.format.options).toEqual([...RESULT_FORMATS]);
    expect(universalFormatFlagDefs.json.type).toBe("boolean");
    expect(universalFormatFlagDefs.json.char).toBe("j");
  });
});

describe("extractFormatFlags", () => {
  test("returns no format when no universal format flag is present", () => {
    const result = extractFormatFlags(["start", "--service", "web"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(false);
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("accepts --format=json (= form)", () => {
    const result = extractFormatFlags(["app:config", "--format=json", "--path", "services"]);
    expect(result.format).toBe("json");
    expect(result.json).toBe(false);
    expect(result.remainingArgv).toEqual(["app:config", "--path", "services"]);
  });

  test("accepts --format table (space form)", () => {
    const result = extractFormatFlags(["apps:list", "--format", "table", "--path", "demo"]);
    expect(result.format).toBe("table");
    expect(result.json).toBe(false);
    expect(result.remainingArgv).toEqual(["apps:list", "--path", "demo"]);
  });

  test("accepts --json and strips it before command parsing", () => {
    const result = extractFormatFlags(["meta:doctor", "--json", "--provider", "docker"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(true);
    expect(result.remainingArgv).toEqual(["meta:doctor", "--provider", "docker"]);
  });

  test("accepts -j and strips it before command parsing", () => {
    const result = extractFormatFlags(["meta:doctor", "-j", "--provider", "docker"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(true);
    expect(result.remainingArgv).toEqual(["meta:doctor", "--provider", "docker"]);
  });

  test("tracks explicit --format and --json while stripping both", () => {
    const result = extractFormatFlags(["apps:list", "--json", "--format=table", "--path", "demo"]);
    expect(result.format).toBe("table");
    expect(result.json).toBe(true);
    expect(result.remainingArgv).toEqual(["apps:list", "--path", "demo"]);
  });

  test("preserves universal format tokens that appear after the `--` argument terminator", () => {
    const result = extractFormatFlags(["app:exec", "--", "bash", "-c", "echo --format=json", "--json", "-j"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(false);
    expect(result.remainingArgv).toEqual([
      "app:exec",
      "--",
      "bash",
      "-c",
      "echo --format=json",
      "--json",
      "-j",
    ]);
  });

  test("strips universal format tokens before `--` and preserves tokens after `--`", () => {
    const result = extractFormatFlags([
      "app:exec",
      "--format=json",
      "--json",
      "--",
      "bash",
      "-c",
      "echo --format=table",
    ]);
    expect(result.format).toBe("json");
    expect(result.json).toBe(true);
    expect(result.remainingArgv).toEqual(["app:exec", "--", "bash", "-c", "echo --format=table"]);
  });

  test("rejects unsupported explicit --format value with tagged error", () => {
    expect(() => extractFormatFlags(["--format=xml"])).toThrow(RendererSelectionError);
    try {
      extractFormatFlags(["--format=xml"]);
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.value).toBe("xml");
      expect(tagged.source).toBe("flag");
      expect(tagged.message).toContain("Unsupported result format value");
      expect(tagged.remediation).toContain("--format=<value>");
      expect(tagged.remediation).toContain("--json");
      expect(tagged.remediation).toContain("-j");
    }
  });

  test("rejects --format with no following value", () => {
    expect(() => extractFormatFlags(["--format"])).toThrow(RendererSelectionError);
  });

  test("rejects --format followed by another flag", () => {
    expect(() => extractFormatFlags(["--format", "--json"])).toThrow(RendererSelectionError);
  });
});

describe("resolveResultFormat", () => {
  test("defaults to text when no flag, renderer bridge, or defaultFormat is supplied", () => {
    const result = resolveResultFormat({});
    expect(result.format).toBe("text");
    expect(result.source).toBe("default");
    expect(result.remainingArgv).toEqual([]);
  });

  test("defaultFormat overrides the hard-coded default", () => {
    const result = resolveResultFormat({ defaultFormat: "table" });
    expect(result.format).toBe("table");
    expect(result.source).toBe("default");
  });

  test("rendererMode json bridges to result format json", () => {
    const result = resolveResultFormat({ argv: ["apps:list"], rendererMode: "json", defaultFormat: "table" });
    expect(result.format).toBe("json");
    expect(result.source).toBe("renderer");
    expect(result.remainingArgv).toEqual(["apps:list"]);
  });

  test("--json wins over renderer bridge and defaultFormat", () => {
    const result = resolveResultFormat({
      argv: ["apps:list", "--json"],
      rendererMode: "plain",
      defaultFormat: "table",
    });
    expect(result.format).toBe("json");
    expect(result.source).toBe("json");
    expect(result.remainingArgv).toEqual(["apps:list"]);
  });

  test("explicit --format wins over --json and renderer json bridge", () => {
    const result = resolveResultFormat({
      argv: ["apps:list", "--json", "--format=table"],
      rendererMode: "json",
      defaultFormat: "text",
    });
    expect(result.format).toBe("table");
    expect(result.source).toBe("format");
    expect(result.remainingArgv).toEqual(["apps:list"]);
  });

  test("explicit --format wins even when -j appears later", () => {
    const result = resolveResultFormat({
      argv: ["meta:config", "--format", "yaml", "-j"],
      rendererMode: "json",
    });
    expect(result.format).toBe("yaml");
    expect(result.source).toBe("format");
    expect(result.remainingArgv).toEqual(["meta:config"]);
  });

  test("invalid explicit --format rejects before renderer bridge is consulted", () => {
    try {
      resolveResultFormat({ argv: ["--format=xml"], rendererMode: "json" });
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.source).toBe("flag");
      expect(tagged.value).toBe("xml");
    }
  });
});
