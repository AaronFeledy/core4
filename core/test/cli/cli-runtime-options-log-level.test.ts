import { afterEach, describe, expect, test } from "bun:test";

import { setActiveLogLevel, setActiveRendererMode } from "../../src/cli/renderer-mode-state.ts";
import { cliRuntimeOptions } from "../../src/testing/engine-layers";

describe("cliRuntimeOptions logLevel", () => {
  afterEach(() => {
    setActiveLogLevel("none");
    setActiveRendererMode("lando");
  });

  test("copies default activeLogLevel none into logLevel", () => {
    const options = cliRuntimeOptions({ bootstrap: "none" });
    expect(options.logLevel).toBe("none");
  });

  test("copies activeLogLevel debug into logLevel", () => {
    setActiveLogLevel("debug");
    const options = cliRuntimeOptions({ bootstrap: "none" });
    expect(options.logLevel).toBe("debug");
  });

  test("keeps an explicit options.logLevel over activeLogLevel", () => {
    setActiveLogLevel("debug");
    const options = cliRuntimeOptions({ bootstrap: "none", logLevel: "warn" });
    expect(options.logLevel).toBe("warn");
  });
});

describe("cliRuntimeOptions renderer", () => {
  afterEach(() => {
    setActiveLogLevel("none");
    setActiveRendererMode("lando");
  });

  test("copies default activeRendererMode lando into renderer", () => {
    const options = cliRuntimeOptions({ bootstrap: "none" });
    expect(options.renderer).toBe("lando");
  });

  test("copies activeRendererMode json into renderer", () => {
    setActiveRendererMode("json");
    const options = cliRuntimeOptions({ bootstrap: "none" });
    expect(options.renderer).toBe("json");
  });

  test("keeps an explicit options.renderer over activeRendererMode", () => {
    setActiveRendererMode("json");
    const options = cliRuntimeOptions({ bootstrap: "none", renderer: "plain" });
    expect(options.renderer).toBe("plain");
  });
});
