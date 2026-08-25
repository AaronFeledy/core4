import { describe, expect, test } from "bun:test";

import { LogLevelSelectionError } from "@lando/sdk/errors";
import { LOG_LEVELS } from "@lando/sdk/schema";

import { extractFormatFlags } from "../../src/cli/format-flags.ts";
import { extractLogLevelFlags, isLandoDebugEnv, resolveLogLevel } from "../../src/cli/log-level-selection.ts";
import { extractRendererFlag } from "../../src/cli/renderer-selection.ts";

const expectLogLevelSelectionError = (run: () => unknown): LogLevelSelectionError => {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    if (!(error instanceof LogLevelSelectionError)) throw error;
    return error;
  }
};

const expectRemediationListsLevels = (remediation: string): void => {
  for (const level of LOG_LEVELS) {
    expect(remediation).toContain(level);
  }
};

describe("log-level-selection baseline", () => {
  test("LogLevelSelectionError is constructable from Wave 1", () => {
    const error = new LogLevelSelectionError({
      message: "unknown log level",
      value: "nope",
      source: "flag",
      remediation: "Use none, error, warn, info, debug, or trace.",
    });
    expect(error._tag).toBe("LogLevelSelectionError");
    expect(error.value).toBe("nope");
    expect(error.source).toBe("flag");
    expect(error.remediation).toContain("none");
    expect(LOG_LEVELS).toEqual(["none", "error", "warn", "info", "debug", "trace"]);
  });

  test("extractFormatFlags still exists and does not consume --debug", () => {
    const result = extractFormatFlags(["start", "--debug", "--format=json"]);
    expect(result.format).toBe("json");
    expect(result.remainingArgv).toEqual(["start", "--debug"]);
  });

  test("extractRendererFlag still exists and leaves --debug on argv", () => {
    const result = extractRendererFlag(["start", "--debug", "--renderer=json"]);
    expect(result.mode).toBe("json");
    expect(result.remainingArgv).toEqual(["start", "--debug"]);
  });
});

describe("extractLogLevelFlags", () => {
  test("accepts --log-level=debug (= form)", () => {
    const result = extractLogLevelFlags(["start", "--log-level=debug", "--service", "web"]);
    expect(result.level).toBe("debug");
    expect(result.debug).toBe(false);
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("accepts --log-level debug (space form)", () => {
    const result = extractLogLevelFlags(["start", "--log-level", "debug", "--service", "web"]);
    expect(result.level).toBe("debug");
    expect(result.debug).toBe(false);
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("last --log-level wins", () => {
    const result = extractLogLevelFlags(["--log-level=info", "--log-level=debug"]);
    expect(result.level).toBe("debug");
    expect(result.remainingArgv).toEqual([]);
  });

  test("does not treat --debug after -- as a flag", () => {
    const result = extractLogLevelFlags(["app:exec", "--", "bash", "--debug"]);
    expect(result.debug).toBe(false);
    expect(result.level).toBeUndefined();
    expect(result.remainingArgv).toEqual(["app:exec", "--", "bash", "--debug"]);
  });

  test("does not consume --log-level after --", () => {
    const result = extractLogLevelFlags(["app:exec", "--", "--log-level=debug"]);
    expect(result.level).toBeUndefined();
    expect(result.remainingArgv).toEqual(["app:exec", "--", "--log-level=debug"]);
  });

  test("consumes --debug as a bare boolean only", () => {
    const result = extractLogLevelFlags(["start", "--debug", "--service", "web"]);
    expect(result.debug).toBe(true);
    expect(result.level).toBeUndefined();
    expect(result.remainingArgv).toEqual(["start", "--service", "web"]);
  });

  test("does not consume --debug=true", () => {
    const result = extractLogLevelFlags(["start", "--debug=true", "--service", "web"]);
    expect(result.debug).toBe(false);
    expect(result.remainingArgv).toEqual(["start", "--debug=true", "--service", "web"]);
  });

  test("throws LogLevelSelectionError for unknown --log-level=nope", () => {
    const error = expectLogLevelSelectionError(() => extractLogLevelFlags(["--log-level=nope"]));
    expect(error.value).toBe("nope");
    expect(error.source).toBe("flag");
    expectRemediationListsLevels(error.remediation);
  });

  test("throws LogLevelSelectionError for missing --log-level value", () => {
    const error = expectLogLevelSelectionError(() => extractLogLevelFlags(["--log-level"]));
    expect(error.source).toBe("flag");
    expect(error.value).toBe("");
    expectRemediationListsLevels(error.remediation);
  });

  test("throws LogLevelSelectionError for empty --log-level=", () => {
    const error = expectLogLevelSelectionError(() => extractLogLevelFlags(["--log-level="]));
    expect(error.source).toBe("flag");
    expect(error.value).toBe("");
    expectRemediationListsLevels(error.remediation);
  });

  test("throws LogLevelSelectionError when --log-level is followed by another flag", () => {
    const error = expectLogLevelSelectionError(() => extractLogLevelFlags(["--log-level", "--debug"]));
    expect(error.source).toBe("flag");
    expect(error.value).toBe("");
  });

  test("throws for uppercase DEBUG value (case-sensitive lowercase only)", () => {
    const error = expectLogLevelSelectionError(() => extractLogLevelFlags(["--log-level=DEBUG"]));
    expect(error.value).toBe("DEBUG");
    expect(error.source).toBe("flag");
    expectRemediationListsLevels(error.remediation);
  });
});

describe("isLandoDebugEnv", () => {
  test("is true for 1, true, and YES after trim and lowercase", () => {
    expect(isLandoDebugEnv("1")).toBe(true);
    expect(isLandoDebugEnv("true")).toBe(true);
    expect(isLandoDebugEnv("YES")).toBe(true);
    expect(isLandoDebugEnv(" True ")).toBe(true);
  });

  test("is false for 0, false, empty, and other tokens", () => {
    expect(isLandoDebugEnv("0")).toBe(false);
    expect(isLandoDebugEnv("false")).toBe(false);
    expect(isLandoDebugEnv("")).toBe(false);
    expect(isLandoDebugEnv("maybe")).toBe(false);
  });
});

describe("resolveLogLevel", () => {
  test("defaults to none", () => {
    expect(resolveLogLevel({})).toEqual({ level: "none", source: "default", remainingArgv: [] });
  });

  test('resolveLogLevel({ argv: ["--debug"] }) is debug from flag', () => {
    const result = resolveLogLevel({ argv: ["--debug"] });
    expect(result.level).toBe("debug");
    expect(result.source).toBe("flag");
  });

  test("--debug --log-level=info selects info (log-level beats --debug)", () => {
    const result = resolveLogLevel({ argv: ["--debug", "--log-level=info"] });
    expect(result.level).toBe("info");
    expect(result.source).toBe("flag");
  });

  test("LANDO_DEBUG=1 plus LANDO_LOG_LEVEL=warn selects warn", () => {
    const result = resolveLogLevel({
      env: { LANDO_DEBUG: "1", LANDO_LOG_LEVEL: "warn" },
    });
    expect(result.level).toBe("warn");
    expect(result.source).toBe("env");
  });

  test("DEBUG=* is ignored when env bag omits it", () => {
    const previous = process.env.DEBUG;
    process.env.DEBUG = "*";
    try {
      const result = resolveLogLevel({ env: { LANDO_LOG_LEVEL: "error" } });
      expect(result.level).toBe("error");
      expect(result.source).toBe("env");
      expect(resolveLogLevel({ env: {} })).toEqual({
        level: "none",
        source: "default",
        remainingArgv: [],
      });
    } finally {
      process.env.DEBUG = previous;
    }
  });

  test("precedence is --log-level over --debug over LANDO_LOG_LEVEL over LANDO_DEBUG over configValue over none", () => {
    expect(
      resolveLogLevel({
        argv: ["--log-level=trace", "--debug"],
        env: { LANDO_LOG_LEVEL: "info", LANDO_DEBUG: "1" },
        configValue: "warn",
      }).level,
    ).toBe("trace");

    expect(
      resolveLogLevel({
        argv: ["--debug"],
        env: { LANDO_LOG_LEVEL: "info", LANDO_DEBUG: "1" },
        configValue: "warn",
      }).level,
    ).toBe("debug");

    expect(
      resolveLogLevel({
        env: { LANDO_LOG_LEVEL: "info", LANDO_DEBUG: "1" },
        configValue: "warn",
      }).level,
    ).toBe("info");

    expect(
      resolveLogLevel({
        env: { LANDO_DEBUG: "1" },
        configValue: "warn",
      }).level,
    ).toBe("debug");

    expect(resolveLogLevel({ configValue: "warn" }).level).toBe("warn");
    expect(resolveLogLevel({}).level).toBe("none");
  });

  test("LANDO_DEBUG 1/true/YES turn debug on; 0/false/empty stay off", () => {
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "1" } }).level).toBe("debug");
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "true" } }).level).toBe("debug");
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "YES" } }).level).toBe("debug");
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "0" } }).level).toBe("none");
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "false" } }).level).toBe("none");
    expect(resolveLogLevel({ env: { LANDO_DEBUG: "" } }).level).toBe("none");
  });

  test("--debug=true is not treated as the debug flag", () => {
    const result = resolveLogLevel({ argv: ["--debug=true"] });
    expect(result.level).toBe("none");
    expect(result.source).toBe("default");
    expect(result.remainingArgv).toEqual(["--debug=true"]);
  });

  test("throws LogLevelSelectionError for unknown --log-level=nope", () => {
    const error = expectLogLevelSelectionError(() => resolveLogLevel({ argv: ["--log-level=nope"] }));
    expect(error.value).toBe("nope");
    expect(error.source).toBe("flag");
    expectRemediationListsLevels(error.remediation);
  });

  test("throws LogLevelSelectionError for empty --log-level=", () => {
    const error = expectLogLevelSelectionError(() => resolveLogLevel({ argv: ["--log-level="] }));
    expect(error.source).toBe("flag");
    expectRemediationListsLevels(error.remediation);
  });
});
