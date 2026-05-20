import { describe, expect, test } from "bun:test";

import { NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";

import {
  DEFERRED_RENDERER_FLAGS,
  DEFERRED_RENDERER_MODES,
  RENDERER_DEFERRED_SPEC_SECTION,
  deferredRendererFlagError,
  deferredRendererModeError,
  findDeferredRendererFlag,
  isDeferredRendererMode,
} from "../../src/cli/renderer-deferred.ts";
import { extractRendererFlag, resolveRendererMode } from "../../src/cli/renderer-selection.ts";

describe("DEFERRED_RENDERER_MODES (US-040 contract)", () => {
  test("contains the verbose renderer mode named in spec/08-cli-and-tooling.md §8.9", () => {
    expect(DEFERRED_RENDERER_MODES.has("verbose")).toBe(true);
  });

  test("every entry carries a Phase 3 Beta or Phase 4 RC remediation pointing at spec/ROADMAP.md", () => {
    for (const [name, surface] of DEFERRED_RENDERER_MODES.entries()) {
      expect(["Phase 3 Beta", "Phase 4 RC"]).toContain(surface.phase);
      expect(surface.remediation).toContain(surface.phase);
      expect(surface.remediation).toContain("spec/ROADMAP.md");
      expect(surface.remediation).toContain("spec/08-cli-and-tooling.md");
      expect(surface.remediation.length).toBeGreaterThan(40);
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/u);
    }
  });

  test("isDeferredRendererMode is true only for entries in the table", () => {
    expect(isDeferredRendererMode("verbose")).toBe(true);
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

  test("covers the expand/collapse and task.detail streaming-tail surfaces from spec §8.9.2", () => {
    for (const flag of REQUIRED_FLAGS) {
      expect(DEFERRED_RENDERER_FLAGS.has(flag)).toBe(true);
    }
  });

  test("every entry carries a Phase 4 RC remediation pointing at spec/ROADMAP.md and §8.9.2", () => {
    for (const [flag, surface] of DEFERRED_RENDERER_FLAGS.entries()) {
      expect(surface.phase).toBe("Phase 4 RC");
      expect(surface.remediation).toContain("Phase 4 RC");
      expect(surface.remediation).toContain("spec/ROADMAP.md");
      expect(surface.remediation).toContain("spec/08-cli-and-tooling.md");
      expect(surface.remediation.length).toBeGreaterThan(40);
      expect(flag.startsWith("--")).toBe(true);
    }
  });
});

describe("deferredRendererModeError", () => {
  test("returns a tagged NotImplementedError with spec section and phase remediation", () => {
    const err = deferredRendererModeError("verbose", "flag");
    expect(err).toBeInstanceOf(NotImplementedError);
    expect(err._tag).toBe("NotImplementedError");
    expect(err.commandId).toBe("cli:renderer-selection");
    expect(err.specSection).toBe(RENDERER_DEFERRED_SPEC_SECTION);
    expect(err.message).toContain("verbose");
    expect(err.message).toContain("flag");
    expect(err.remediation).toContain("Phase 3 Beta");
    expect(err.remediation).toContain("spec/ROADMAP.md");
  });

  test("source label changes per origin (flag, env, config)", () => {
    expect(deferredRendererModeError("verbose", "env").message).toContain("env");
    expect(deferredRendererModeError("verbose", "config").message).toContain("config");
  });
});

describe("deferredRendererFlagError", () => {
  test("returns a tagged NotImplementedError with Phase 4 RC remediation for --no-expand", () => {
    const err = deferredRendererFlagError("--no-expand");
    expect(err).toBeInstanceOf(NotImplementedError);
    expect(err._tag).toBe("NotImplementedError");
    expect(err.commandId).toBe("cli:renderer-selection");
    expect(err.specSection).toBe(RENDERER_DEFERRED_SPEC_SECTION);
    expect(err.message).toContain("--no-expand");
    expect(err.remediation).toContain("Phase 4 RC");
    expect(err.remediation).toContain("spec/ROADMAP.md");
  });

  test("--tail remediation calls out the task.detail streaming-tail feature", () => {
    const err = deferredRendererFlagError("--tail");
    expect(err.remediation).toContain("task.detail");
  });
});

describe("findDeferredRendererFlag", () => {
  test("returns the first deferred flag before any POSIX `--` terminator", () => {
    expect(findDeferredRendererFlag(["apps:list", "--no-expand"])).toBe("--no-expand");
    expect(findDeferredRendererFlag(["apps:list", "--collapse", "extra"])).toBe("--collapse");
    expect(findDeferredRendererFlag(["--tail"])).toBe("--tail");
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

  test("resolveRendererMode throws NotImplementedError for --renderer=verbose (flag source)", () => {
    try {
      resolveRendererMode({ argv: ["--renderer=verbose"] });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      if (!(error instanceof NotImplementedError)) return;
      expect(error.message).toContain("flag");
      expect(error.remediation).toContain("Phase 3 Beta");
    }
  });

  test("resolveRendererMode throws NotImplementedError for LANDO_RENDERER=verbose (env source)", () => {
    try {
      resolveRendererMode({ argv: [], env: { LANDO_RENDERER: "verbose" } });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      if (!(error instanceof NotImplementedError)) return;
      expect(error.message).toContain("env");
      expect(error.remediation).toContain("Phase 3 Beta");
    }
  });

  test("resolveRendererMode throws NotImplementedError when configValue is a deferred mode", () => {
    try {
      resolveRendererMode({ argv: [], configValue: "verbose" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      if (!(error instanceof NotImplementedError)) return;
      expect(error.message).toContain("config");
      expect(error.remediation).toContain("Phase 3 Beta");
    }
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
    expect(() => resolveRendererMode({ argv: ["--renderer=json", "--tail"] })).toThrow(NotImplementedError);
    expect(() => resolveRendererMode({ argv: ["--tail", "--renderer=json"] })).toThrow(NotImplementedError);
  });
});
