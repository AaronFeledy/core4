import { describe, expect, test } from "bun:test";

import { RendererSelectionError } from "@lando/sdk/errors";

import {
  DEFAULT_RENDERER_MODE,
  RENDERER_ENV_VAR,
  RENDERER_MODES,
  extractRendererFlag,
  isRendererMode,
  resolveRendererMode,
} from "../../src/cli/renderer-selection.ts";

describe("renderer-selection constants", () => {
  test("RENDERER_MODES is lando, json, plain, verbose", () => {
    expect(RENDERER_MODES).toEqual(["lando", "json", "plain", "verbose"]);
  });

  test("DEFAULT_RENDERER_MODE is lando", () => {
    expect(DEFAULT_RENDERER_MODE).toBe("lando");
  });

  test("RENDERER_ENV_VAR is LANDO_RENDERER", () => {
    expect(RENDERER_ENV_VAR).toBe("LANDO_RENDERER");
  });

  test("isRendererMode accepts supported values only", () => {
    expect(isRendererMode("lando")).toBe(true);
    expect(isRendererMode("json")).toBe(true);
    expect(isRendererMode("plain")).toBe(true);
    expect(isRendererMode("verbose")).toBe(true);
    expect(isRendererMode("")).toBe(false);
    expect(isRendererMode("LANDO")).toBe(false);
    expect(isRendererMode("tui")).toBe(false);
  });
});

describe("extractRendererFlag", () => {
  test("returns undefined mode when no flag present", () => {
    const result = extractRendererFlag(["start", "--service", "web"]);
    expect(result.mode).toBeUndefined();
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("accepts --renderer=json (= form)", () => {
    const result = extractRendererFlag(["--renderer=json"]);
    expect(result.mode).toBe("json");
    expect(result.remainingArgv).toEqual([]);
  });

  test("accepts --renderer plain (space form)", () => {
    const result = extractRendererFlag(["--renderer", "plain"]);
    expect(result.mode).toBe("plain");
    expect(result.remainingArgv).toEqual([]);
  });

  test("strips --renderer from argv while preserving other args", () => {
    const result = extractRendererFlag(["start", "--renderer=json", "--service", "web"]);
    expect(result.mode).toBe("json");
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("strips space-form --renderer cleanly", () => {
    const result = extractRendererFlag(["start", "--renderer", "plain", "--service", "web"]);
    expect(result.mode).toBe("plain");
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("rejects unsupported flag value with tagged error", () => {
    expect(() => extractRendererFlag(["--renderer=tui"])).toThrow(RendererSelectionError);
    try {
      extractRendererFlag(["--renderer=tui"]);
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.value).toBe("tui");
      expect(tagged.source).toBe("flag");
      expect(tagged.remediation).toContain("lando");
      expect(tagged.remediation).toContain("json");
      expect(tagged.remediation).toContain("plain");
      expect(tagged.message).toContain("tui");
    }
  });

  test("rejects --renderer with no following value", () => {
    expect(() => extractRendererFlag(["--renderer"])).toThrow(RendererSelectionError);
  });

  test("rejects --renderer followed by another flag (no value supplied)", () => {
    expect(() => extractRendererFlag(["--renderer", "--service", "web"])).toThrow(RendererSelectionError);
  });

  test("rejects --renderer= (empty value)", () => {
    expect(() => extractRendererFlag(["--renderer="])).toThrow(RendererSelectionError);
  });

  test("the last --renderer wins when multiple are supplied", () => {
    const result = extractRendererFlag(["--renderer=json", "--renderer=plain"]);
    expect(result.mode).toBe("plain");
    expect(result.remainingArgv).toEqual([]);
  });

  test("preserves --renderer tokens that appear after the `--` argument terminator", () => {
    const result = extractRendererFlag([
      "app:exec",
      "--",
      "bash",
      "-c",
      "echo --renderer=json",
      "--renderer=plain",
    ]);
    expect(result.mode).toBeUndefined();
    expect(result.remainingArgv).toEqual([
      "app:exec",
      "--",
      "bash",
      "-c",
      "echo --renderer=json",
      "--renderer=plain",
    ]);
  });

  test("strips --renderer before `--`, preserves --renderer after `--`", () => {
    const result = extractRendererFlag([
      "app:exec",
      "--renderer=json",
      "--",
      "bash",
      "-c",
      "echo --renderer=plain",
    ]);
    expect(result.mode).toBe("json");
    expect(result.remainingArgv).toEqual(["app:exec", "--", "bash", "-c", "echo --renderer=plain"]);
  });
});

describe("resolveRendererMode", () => {
  test("defaults to lando when no flag/env/config", () => {
    const result = resolveRendererMode({});
    expect(result.mode).toBe("lando");
    expect(result.source).toBe("default");
    expect(result.remainingArgv).toEqual([]);
  });

  test("flag wins over env and config", () => {
    const result = resolveRendererMode({
      argv: ["--renderer=plain"],
      env: { LANDO_RENDERER: "json" },
      configValue: "json",
    });
    expect(result.mode).toBe("plain");
    expect(result.source).toBe("flag");
  });

  test("env wins over config when flag absent", () => {
    const result = resolveRendererMode({
      env: { LANDO_RENDERER: "plain" },
      configValue: "json",
    });
    expect(result.mode).toBe("plain");
    expect(result.source).toBe("env");
  });

  test("config wins over default when flag and env absent", () => {
    const result = resolveRendererMode({ configValue: "json" });
    expect(result.mode).toBe("json");
    expect(result.source).toBe("config");
  });

  test("empty env string falls through to next source", () => {
    const result = resolveRendererMode({
      env: { LANDO_RENDERER: "" },
      configValue: "json",
    });
    expect(result.mode).toBe("json");
    expect(result.source).toBe("config");
  });

  test("rejects unsupported env value with source=env tagged error", () => {
    try {
      resolveRendererMode({ env: { LANDO_RENDERER: "tui" } });
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.source).toBe("env");
      expect(tagged.value).toBe("tui");
    }
  });

  test("rejects unsupported config value with source=config tagged error", () => {
    try {
      resolveRendererMode({ configValue: "tui" });
      expect.unreachable();
    } catch (error) {
      const tagged = error as RendererSelectionError;
      expect(tagged._tag).toBe("RendererSelectionError");
      expect(tagged.source).toBe("config");
      expect(tagged.value).toBe("tui");
    }
  });

  test("preserves remainingArgv from flag extraction in non-flag sources", () => {
    const result = resolveRendererMode({
      argv: ["doctor", "--service", "web"],
      env: { LANDO_RENDERER: "json" },
    });
    expect(result.mode).toBe("json");
    expect(result.source).toBe("env");
    expect(result.remainingArgv).toEqual(["doctor", "--service", "web"]);
  });

  test("custom defaultMode overrides hard-coded lando default", () => {
    const result = resolveRendererMode({ defaultMode: "plain" });
    expect(result.mode).toBe("plain");
    expect(result.source).toBe("default");
  });

  test("invalid flag short-circuits before env precedence is consulted", () => {
    try {
      resolveRendererMode({
        argv: ["--renderer=tui"],
        env: { LANDO_RENDERER: "json" },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as RendererSelectionError).source).toBe("flag");
    }
  });
});
