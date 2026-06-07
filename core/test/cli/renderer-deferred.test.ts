import { describe, expect, test } from "bun:test";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import {
  DEFERRED_RENDERER_FLAGS,
  DEFERRED_RENDERER_MODES,
  deferredRendererFlagError,
  deferredRendererModeError,
  findDeferredRendererFlag,
  isDeferredRendererMode,
} from "../../src/cli/renderer-deferred.ts";
import { extractRendererFlag, resolveRendererMode } from "../../src/cli/renderer-selection.ts";

describe("DEFERRED_RENDERER_MODES", () => {
  test("no renderer mode is currently deferred (verbose has shipped)", () => {
    expect(DEFERRED_RENDERER_MODES.has("verbose")).toBe(false);
    expect(DEFERRED_RENDERER_MODES.size).toBe(0);
  });

  test("any future entry must carry a remediation pointing at the current command list", () => {
    for (const [name, surface] of DEFERRED_RENDERER_MODES.entries()) {
      expect(surface.remediation).toContain("not available yet");
      expect(surface.remediation.length).toBeGreaterThan(40);
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/u);
    }
  });

  test("isDeferredRendererMode is false for every shipped renderer mode", () => {
    expect(isDeferredRendererMode("verbose")).toBe(false);
    expect(isDeferredRendererMode("lando")).toBe(false);
    expect(isDeferredRendererMode("json")).toBe(false);
    expect(isDeferredRendererMode("plain")).toBe(false);
    expect(isDeferredRendererMode("tui")).toBe(false);
    expect(isDeferredRendererMode("")).toBe(false);
  });
});

describe("DEFERRED_RENDERER_FLAGS (US-040 contract)", () => {
  const REQUIRED_FLAGS = [
    "--expand",
    "--no-expand",
    "--collapse",
    "--no-collapse",
    "--tail",
    "--no-tail",
  ] as const;

  test("covers the expand/collapse and task.detail streaming-tail surfaces", () => {
    for (const flag of REQUIRED_FLAGS) {
      expect(DEFERRED_RENDERER_FLAGS.has(flag)).toBe(true);
    }
  });

  test("every entry carries actionable remediation", () => {
    for (const [flag, surface] of DEFERRED_RENDERER_FLAGS.entries()) {
      expect(surface.remediation).toContain("not available yet");
      expect(surface.remediation.length).toBeGreaterThan(40);
      expect(flag.startsWith("--")).toBe(true);
    }
  });
});

describe("deferredRendererModeError", () => {
  test("throws the internal guard for a mode value that is not registered as deferred", () => {
    expect(() => deferredRendererModeError("verbose", "flag")).toThrow(/no deferred surface registered/u);
  });
});

describe("deferredRendererFlagError", () => {
  test("returns a tagged NotImplementedError with remediation for --no-expand configuration", () => {
    const err = deferredRendererFlagError("--no-expand");
    expect(err).toBeInstanceOf(NotImplementedError);
    expect(err._tag).toBe("NotImplementedError");
    expect(err.commandId).toBe("cli:renderer-selection");
    expect(err.message).toContain("--no-expand");
    expect(err.remediation).toContain("default Enter/Esc task-detail expand/collapse keybindings");
    expect(err.remediation).toContain(
      "User-configurable expand/collapse control flags are not available yet",
    );
  });

  test("--tail remediation says the control flag, not the fixed tail, is unavailable", () => {
    const err = deferredRendererFlagError("--tail");
    expect(err.remediation).toContain("task.detail");
    expect(err.remediation).toContain("fixed `task.detail` tail");
    expect(err.remediation).toContain("control flag is not available yet");
  });
});

describe("findDeferredRendererFlag", () => {
  test("returns the first deferred flag before any POSIX `--` terminator", () => {
    expect(findDeferredRendererFlag(["apps:list", "--no-expand"])).toBe("--no-expand");
    expect(findDeferredRendererFlag(["apps:list", "--collapse", "extra"])).toBe("--collapse");
    expect(findDeferredRendererFlag(["apps:list", "--tail"])).toBe("--tail");
  });

  test("matches --flag=value forms (returns the bare flag name)", () => {
    expect(findDeferredRendererFlag(["--no-expand=true"])).toBe("--no-expand");
  });

  test("returns undefined for argv that does not include any deferred flag", () => {
    expect(findDeferredRendererFlag(["apps:list", "--renderer=json", "--help"])).toBeUndefined();
    expect(findDeferredRendererFlag([])).toBeUndefined();
  });

  test("does not intercept deferred flag names after the POSIX `--` terminator", () => {
    expect(findDeferredRendererFlag(["app:exec", "--", "bash", "-c", "echo --no-expand"])).toBeUndefined();
  });

  test("does not intercept app:logs --tail because it is a command-specific Alpha flag", () => {
    expect(findDeferredRendererFlag(["logs", "--tail", "25"])).toBeUndefined();
    expect(findDeferredRendererFlag(["app:logs", "--tail=25"])).toBeUndefined();
  });
});

describe("renderer-selection integration with deferred surfaces", () => {
  test("extractRendererFlag throws NotImplementedError when a deferred flag is in argv", () => {
    expect(() => extractRendererFlag(["apps:list", "--no-expand"])).toThrow(NotImplementedError);
  });

  test("extractRendererFlag does not throw RendererSelectionError for deferred flags", () => {
    try {
      extractRendererFlag(["apps:list", "--collapse"]);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect(error).not.toBeInstanceOf(RendererSelectionError);
    }
  });

  test("resolveRendererMode accepts --renderer=verbose as a shipped mode (flag source)", () => {
    const result = resolveRendererMode({ argv: ["--renderer=verbose"] });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("flag");
  });

  test("resolveRendererMode accepts LANDO_RENDERER=verbose (env source)", () => {
    const result = resolveRendererMode({ argv: [], env: { LANDO_RENDERER: "verbose" } });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("env");
  });

  test("resolveRendererMode accepts a verbose configValue (config source)", () => {
    const result = resolveRendererMode({ argv: [], configValue: "verbose" });
    expect(result.mode).toBe("verbose");
    expect(result.source).toBe("config");
  });

  test("non-deferred invalid renderer values still raise RendererSelectionError (existing behavior preserved)", () => {
    try {
      resolveRendererMode({ argv: ["--renderer=tui"] });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RendererSelectionError);
      expect(error).not.toBeInstanceOf(NotImplementedError);
    }
  });

  test("valid renderer values still work (--renderer=lando|json|plain)", () => {
    expect(resolveRendererMode({ argv: ["--renderer=lando"] }).mode).toBe("lando");
    expect(resolveRendererMode({ argv: ["--renderer=json"] }).mode).toBe("json");
    expect(resolveRendererMode({ argv: ["--renderer=plain"] }).mode).toBe("plain");
  });

  test("deferred flag rejection happens before --renderer parsing (so order does not matter)", () => {
    expect(() => resolveRendererMode({ argv: ["--renderer=json", "--collapse"] })).toThrow(
      NotImplementedError,
    );
    expect(() => resolveRendererMode({ argv: ["--collapse", "--renderer=json"] })).toThrow(
      NotImplementedError,
    );
    expect(() => resolveRendererMode({ argv: ["--renderer=json", "--tail"] })).toThrow(NotImplementedError);
  });

  test("logs --tail remains available for the app logs command", () => {
    expect(resolveRendererMode({ argv: ["logs", "--tail", "25"] })).toEqual({
      mode: "lando",
      remainingArgv: ["logs", "--tail", "25"],
      source: "default",
    });
    expect(resolveRendererMode({ argv: ["app:logs", "--tail=25"] })).toEqual({
      mode: "lando",
      remainingArgv: ["app:logs", "--tail=25"],
      source: "default",
    });
  });
});
