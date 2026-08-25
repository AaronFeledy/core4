import { describe, expect, test } from "bun:test";

import { RendererSelectionError } from "@lando/sdk/errors";

import {
  DEFAULT_RESULT_FORMAT,
  RESULT_FORMATS,
  extractFormatFlags,
  isResultFormat,
  parseJsonFieldList,
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

describe("parseJsonFieldList", () => {
  test("splits and trims comma-separated field names", () => {
    expect(parseJsonFieldList("app,services")).toEqual(["app", "services"]);
    expect(parseJsonFieldList(" app , services ")).toEqual(["app", "services"]);
  });

  test("accepts a single equals-form identifier", () => {
    expect(parseJsonFieldList("echo")).toEqual(["echo"]);
  });

  test("accepts a dotted field name", () => {
    expect(parseJsonFieldList("app.services")).toEqual(["app.services"]);
  });

  test("rejects empty segments with tagged error", () => {
    expect(() => parseJsonFieldList("")).toThrow(RendererSelectionError);
    expect(() => parseJsonFieldList("app,")).toThrow(RendererSelectionError);
    expect(() => parseJsonFieldList(",app")).toThrow(RendererSelectionError);
    try {
      parseJsonFieldList("app,");
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.source).toBe("flag");
    }
  });
});

describe("extractFormatFlags", () => {
  test("returns no format when no universal format flag is present", () => {
    const result = extractFormatFlags(["start", "--service", "web"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(false);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toBeUndefined();
    expect(result.jq).toBeUndefined();
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

  test("accepts bare --json as list-mode and strips it before command parsing", () => {
    const result = extractFormatFlags(["meta:doctor", "--json", "--provider", "docker"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(true);
    expect(result.jsonFields).toBeUndefined();
    expect(result.remainingArgv).toEqual(["meta:doctor", "--provider", "docker"]);
  });

  test("accepts -j as boolean-only and strips it before command parsing", () => {
    const result = extractFormatFlags(["meta:doctor", "-j", "--provider", "docker"]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toBeUndefined();
    expect(result.remainingArgv).toEqual(["meta:doctor", "--provider", "docker"]);
  });

  test("does not consume the token after -j", () => {
    const result = extractFormatFlags(["exec", "-j", "echo"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toBeUndefined();
    expect(result.remainingArgv).toEqual(["exec", "echo"]);
  });

  test("parses --json=k1,k2 as a field list", () => {
    const result = extractFormatFlags(["info", "--json=k1,k2"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toEqual(["k1", "k2"]);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("parses --json=echo as a single-field list", () => {
    const result = extractFormatFlags(["info", "--json=echo"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toEqual(["echo"]);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("consumes space-form --json k1,k2 as a field list", () => {
    const result = extractFormatFlags(["info", "--json", "app,services"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toEqual(["app", "services"]);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("consumes space-form --json dotted key as a field list", () => {
    const result = extractFormatFlags(["info", "--json", "app.services"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toEqual(["app.services"]);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("does not consume a bare identifier after space-form --json", () => {
    const result = extractFormatFlags(["exec", "--json", "echo"]);
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(true);
    expect(result.jsonFields).toBeUndefined();
    expect(result.remainingArgv).toEqual(["exec", "echo"]);
  });

  test("rejects empty --json= field list with tagged error", () => {
    expect(() => extractFormatFlags(["info", "--json="])).toThrow(RendererSelectionError);
    expect(() => extractFormatFlags(["info", "--json=app,"])).toThrow(RendererSelectionError);
  });

  test("parses space-form --jq as a required value", () => {
    const result = extractFormatFlags(["info", "--jq", ".ok"]);
    expect(result.jq).toBe(".ok");
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("parses --jq=.result equals form", () => {
    const result = extractFormatFlags(["info", "--jq=.result"]);
    expect(result.jq).toBe(".result");
    expect(result.json).toBe(true);
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("rejects missing --jq value with tagged error", () => {
    expect(() => extractFormatFlags(["info", "--jq"])).toThrow(RendererSelectionError);
    expect(() => extractFormatFlags(["info", "--jq="])).toThrow(RendererSelectionError);
    expect(() => extractFormatFlags(["info", "--jq", "--format=json"])).toThrow(RendererSelectionError);
    try {
      extractFormatFlags(["info", "--jq"]);
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.source).toBe("flag");
      expect(tagged.value).toBe("");
    }
  });

  test("tracks explicit --format and --json while stripping both", () => {
    const result = extractFormatFlags(["apps:list", "--json", "--format=table", "--path", "demo"]);
    expect(result.format).toBe("table");
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(true);
    expect(result.remainingArgv).toEqual(["apps:list", "--path", "demo"]);
  });

  test("preserves universal format tokens that appear after the `--` argument terminator", () => {
    const result = extractFormatFlags([
      "app:exec",
      "--",
      "bash",
      "-c",
      "echo --format=json",
      "--json",
      "-j",
      "--jq",
      ".ok",
    ]);
    expect(result.format).toBeUndefined();
    expect(result.json).toBe(false);
    expect(result.jsonList).toBe(false);
    expect(result.jq).toBeUndefined();
    expect(result.remainingArgv).toEqual([
      "app:exec",
      "--",
      "bash",
      "-c",
      "echo --format=json",
      "--json",
      "-j",
      "--jq",
      ".ok",
    ]);
  });

  test("strips universal format tokens before `--` and preserves tokens after `--`", () => {
    const result = extractFormatFlags([
      "app:exec",
      "--format=json",
      "--json",
      "--jq=.ok",
      "--",
      "bash",
      "-c",
      "echo --format=table",
    ]);
    expect(result.format).toBe("json");
    expect(result.json).toBe(true);
    expect(result.jq).toBe(".ok");
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

  test("--jq implies json format when --format is absent", () => {
    const result = resolveResultFormat({
      argv: ["info", "--jq", ".ok"],
      defaultFormat: "table",
    });
    expect(result.format).toBe("json");
    expect(result.source).toBe("json");
    expect(result.remainingArgv).toEqual(["info"]);
  });

  test("explicit --format still wins when --jq is present", () => {
    const result = resolveResultFormat({
      argv: ["info", "--jq", ".ok", "--format=yaml"],
    });
    expect(result.format).toBe("yaml");
    expect(result.source).toBe("format");
    expect(result.remainingArgv).toEqual(["info"]);
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
