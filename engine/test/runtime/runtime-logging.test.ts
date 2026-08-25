import { describe, expect, test } from "bun:test";

import { resolveRuntimeLogging } from "../../src/runtime/runtime-options.ts";

describe("resolveRuntimeLogging", () => {
  test("omitted level stays silent", () => {
    expect(resolveRuntimeLogging({})).toEqual({
      loggerMode: "silent",
      logLevel: undefined,
      structured: false,
    });
  });

  test("none stays silent", () => {
    expect(resolveRuntimeLogging({ logLevel: "none" })).toEqual({
      loggerMode: "silent",
      logLevel: "none",
      structured: false,
    });
  });

  test("options.logLevel debug uses pretty mode and passes the level", () => {
    expect(resolveRuntimeLogging({ logLevel: "debug" })).toEqual({
      loggerMode: "pretty",
      logLevel: "debug",
      structured: true,
    });
  });

  test("config.logLevel is honored when options.logLevel is omitted", () => {
    expect(resolveRuntimeLogging({ config: { logLevel: "info" } })).toEqual({
      loggerMode: "pretty",
      logLevel: "info",
      structured: true,
    });
  });

  test("options.logLevel wins over config.logLevel", () => {
    expect(resolveRuntimeLogging({ logLevel: "error", config: { logLevel: "debug" } })).toEqual({
      loggerMode: "pretty",
      logLevel: "error",
      structured: true,
    });
  });

  test("logger pretty remains an independent override without a diagnostic level", () => {
    expect(resolveRuntimeLogging({ logger: "pretty" })).toEqual({
      loggerMode: "pretty",
      logLevel: undefined,
      structured: false,
    });
  });

  test("json renderer plus debug forces structured logs", () => {
    expect(resolveRuntimeLogging({ renderer: "json", logLevel: "debug" })).toEqual({
      loggerMode: "pretty",
      logLevel: "debug",
      structured: true,
    });
  });

  test("non-json renderer plus debug stays unstructured", () => {
    expect(resolveRuntimeLogging({ renderer: "lando", logLevel: "debug" })).toEqual({
      loggerMode: "pretty",
      logLevel: "debug",
      structured: false,
    });
  });
});
