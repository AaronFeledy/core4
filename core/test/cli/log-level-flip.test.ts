import { afterEach, describe, expect, test } from "bun:test";

import type { LogLevel } from "@lando/sdk/schema";

import { resolveLogLevel } from "../../src/cli/log-level-selection.ts";
import { applyDebugRendererFlip, readConfigCliGlobals } from "../../src/cli/renderer-mode-resolution.ts";
import { activeLogLevel, setActiveLogLevel } from "../../src/cli/renderer-mode-state.ts";
import {
  DEFAULT_RENDERER_MODE,
  type ResolveRendererModeResult,
  resolveRendererMode,
} from "../../src/cli/renderer-selection.ts";

const defaultRenderer = (): ResolveRendererModeResult => resolveRendererMode({});

describe("renderer flip characterization", () => {
  test("default renderer is lando", () => {
    expect(DEFAULT_RENDERER_MODE).toBe("lando");
    expect(defaultRenderer().mode).toBe("lando");
    expect(defaultRenderer().source).toBe("default");
  });

  test("resolveRendererMode source default/flag/env/config still works", () => {
    expect(defaultRenderer().source).toBe("default");
    expect(resolveRendererMode({ argv: ["--renderer=json"] }).source).toBe("flag");
    expect(resolveRendererMode({ env: { LANDO_RENDERER: "plain" } }).source).toBe("env");
    expect(resolveRendererMode({ configValue: "verbose" }).source).toBe("config");
  });
});

describe("applyDebugRendererFlip", () => {
  test("default + debug flips to verbose", () => {
    expect(applyDebugRendererFlip({ level: "debug", renderer: defaultRenderer() })).toBe("verbose");
  });

  test("default + trace flips to verbose", () => {
    expect(applyDebugRendererFlip({ level: "trace", renderer: defaultRenderer() })).toBe("verbose");
  });

  test("default + info stays lando", () => {
    expect(applyDebugRendererFlip({ level: "info", renderer: defaultRenderer() })).toBe("lando");
  });

  test("default + warn stays lando", () => {
    expect(applyDebugRendererFlip({ level: "warn", renderer: defaultRenderer() })).toBe("lando");
  });

  test("default + error stays lando", () => {
    expect(applyDebugRendererFlip({ level: "error", renderer: defaultRenderer() })).toBe("lando");
  });

  test("flag --renderer=lando + debug stays lando", () => {
    expect(
      applyDebugRendererFlip({
        level: "debug",
        renderer: resolveRendererMode({ argv: ["--renderer=lando"] }),
      }),
    ).toBe("lando");
  });

  test("flag --renderer=json + debug stays json", () => {
    expect(
      applyDebugRendererFlip({
        level: "debug",
        renderer: resolveRendererMode({ argv: ["--renderer=json"] }),
      }),
    ).toBe("json");
  });

  test("flag --renderer=plain + debug stays plain", () => {
    expect(
      applyDebugRendererFlip({
        level: "debug",
        renderer: resolveRendererMode({ argv: ["--renderer=plain"] }),
      }),
    ).toBe("plain");
  });

  test("env LANDO_RENDERER=lando + debug stays lando", () => {
    expect(
      applyDebugRendererFlip({
        level: "debug",
        renderer: resolveRendererMode({ env: { LANDO_RENDERER: "lando" } }),
      }),
    ).toBe("lando");
  });

  test("config renderer lando + debug stays lando", () => {
    expect(
      applyDebugRendererFlip({
        level: "debug",
        renderer: resolveRendererMode({ configValue: "lando" }),
      }),
    ).toBe("lando");
  });

  test("--debug and --log-level=debug produce the same flip", () => {
    const renderer = defaultRenderer();
    const fromDebug = applyDebugRendererFlip({
      level: resolveLogLevel({ argv: ["--debug"] }).level,
      renderer,
    });
    const fromLogLevel = applyDebugRendererFlip({
      level: resolveLogLevel({ argv: ["--log-level=debug"] }).level,
      renderer,
    });
    expect(fromDebug).toBe("verbose");
    expect(fromLogLevel).toBe(fromDebug);
  });

  test("source is not debug-flip after a default+debug flip", () => {
    const renderer = defaultRenderer();
    const mode = applyDebugRendererFlip({ level: "debug", renderer });
    expect(mode).toBe("verbose");
    expect(renderer.source).toBe("default");
    expect(renderer.source).not.toEqual("debug-flip");
    const allowed: ReadonlyArray<ResolveRendererModeResult["source"]> = ["flag", "env", "config", "default"];
    expect(allowed).toContain(renderer.source);
  });
});

describe("readConfigCliGlobals", () => {
  test("returns an object with optional renderer and logLevel strings", async () => {
    const globals = await readConfigCliGlobals();
    expect(globals).toBeDefined();
    expect(typeof globals).toBe("object");
    expect(globals.renderer === undefined || typeof globals.renderer === "string").toBe(true);
    expect(globals.logLevel === undefined || typeof globals.logLevel === "string").toBe(true);
  });
});

describe("activeLogLevel module state", () => {
  afterEach(() => {
    setActiveLogLevel("none");
  });

  test("defaults to none", () => {
    expect(activeLogLevel).toBe("none");
  });

  test("setActiveLogLevel updates the module state", () => {
    const next: LogLevel = "debug";
    setActiveLogLevel(next);
    expect(activeLogLevel).toBe(next);
  });
});
