import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { LogLevelSelectionError, RendererSelectionError } from "@lando/sdk/errors";
import { GlobalConfig, LOG_LEVELS } from "@lando/sdk/schema";

describe("log-level contracts baseline", () => {
  test("decodes GlobalConfig when logLevel is omitted", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({});
    expect("logLevel" in decoded).toBe(false);
    expect(decoded.renderer).toBeUndefined();
  });

  test("constructs RendererSelectionError with flag env and config sources", () => {
    const fields = Object.keys(RendererSelectionError.fields);
    expect(fields).toEqual(["_tag", "message", "value", "source", "remediation"]);

    const sources = ["flag", "env", "config"] as const;
    for (const source of sources) {
      const error = new RendererSelectionError({
        message: "unknown renderer",
        value: "nope",
        source,
        remediation: "Use lando, json, plain, or verbose.",
      });
      expect(error._tag).toBe("RendererSelectionError");
      expect(error.value).toBe("nope");
      expect(error.source).toBe(source);
      expect(error.remediation).toBe("Use lando, json, plain, or verbose.");
    }
  });
});

describe("GlobalConfig.logLevel decode", () => {
  test("accepts a known logLevel string", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ logLevel: "debug" });
    expect(decoded.logLevel).toBe("debug");
  });

  test("accepts an unknown logLevel string at config load", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ logLevel: "nope" });
    expect(decoded.logLevel).toBe("nope");
  });

  test("rejects a non-string logLevel", () => {
    const result = Schema.decodeUnknownEither(GlobalConfig)({ logLevel: 1 });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("LOG_LEVELS", () => {
  test("exports the six lowercase level tokens in rank order", () => {
    expect(LOG_LEVELS).toEqual(["none", "error", "warn", "info", "debug", "trace"]);
  });
});

describe("LogLevelSelectionError", () => {
  test("constructs with flag env and config sources", () => {
    const fields = Object.keys(LogLevelSelectionError.fields);
    expect(fields).toEqual(["_tag", "message", "value", "source", "remediation"]);
    expect(fields).not.toContain("commandId");

    const sources = ["flag", "env", "config"] as const;
    for (const source of sources) {
      const error = new LogLevelSelectionError({
        message: "unknown log level",
        value: "nope",
        source,
        remediation: "Use none, error, warn, info, debug, or trace.",
      });
      expect(error._tag).toBe("LogLevelSelectionError");
      expect(error.value).toBe("nope");
      expect(error.source).toBe(source);
      expect(error.remediation).toBe("Use none, error, warn, info, debug, or trace.");
    }
  });
});
