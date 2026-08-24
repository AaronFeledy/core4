import { describe, expect, test } from "bun:test";

import { bold, cyan, dim, reset, shouldStyleHelp } from "../../src/cli/help-style.ts";

const styledOn = {
  isTTY: true,
  env: {} as Readonly<Record<string, string | undefined>>,
  argv: [] as const,
  rendererMode: "lando",
} as const;

describe("shouldStyleHelp", () => {
  test("turns style off when NO_COLOR is 1", () => {
    // Given a TTY lando session with NO_COLOR set
    const input = { ...styledOn, env: { NO_COLOR: "1" } };

    // When the style gate is evaluated
    const styled = shouldStyleHelp(input);

    // Then color is suppressed
    expect(styled).toBe(false);
  });

  test("turns style off when isTTY is false", () => {
    // Given a piped/non-TTY stdout
    const input = { ...styledOn, isTTY: false };

    // When the style gate is evaluated
    const styled = shouldStyleHelp(input);

    // Then color is suppressed
    expect(styled).toBe(false);
  });

  test("turns style off when argv has --format=json", () => {
    // Given machine-output argv
    const input = { ...styledOn, argv: ["help", "--format=json"] as const };

    // When the style gate is evaluated
    const styled = shouldStyleHelp(input);

    // Then color is suppressed
    expect(styled).toBe(false);
  });

  test("turns style off when argv has --format json", () => {
    // Given the space-separated json format flag
    const input = { ...styledOn, argv: ["help", "--format", "json"] as const };

    // When the style gate is evaluated
    const styled = shouldStyleHelp(input);

    // Then color is suppressed
    expect(styled).toBe(false);
  });

  test("turns style off when argv has --json", () => {
    const styled = shouldStyleHelp({ ...styledOn, argv: ["help", "--json"] });
    expect(styled).toBe(false);
  });

  test("turns style off when argv has -j", () => {
    const styled = shouldStyleHelp({ ...styledOn, argv: ["help", "-j"] });
    expect(styled).toBe(false);
  });

  test("turns style off when rendererMode is not lando", () => {
    const styled = shouldStyleHelp({ ...styledOn, rendererMode: "plain" });
    expect(styled).toBe(false);
  });

  test("turns style on when forced TTY and lando renderer", () => {
    // Given an interactive default-renderer session
    const input = styledOn;

    // When the style gate is evaluated
    const styled = shouldStyleHelp(input);

    // Then color is allowed
    expect(styled).toBe(true);
  });

  test("turns style on when rendererMode is undefined on a TTY", () => {
    const styled = shouldStyleHelp({ ...styledOn, rendererMode: undefined });
    expect(styled).toBe(true);
  });

  test("ignores FORCE_COLOR when deciding style", () => {
    expect(
      shouldStyleHelp({
        ...styledOn,
        isTTY: false,
        env: { FORCE_COLOR: "1" },
      }),
    ).toBe(false);
    expect(
      shouldStyleHelp({
        ...styledOn,
        env: { FORCE_COLOR: "0" },
      }),
    ).toBe(true);
  });

  test("treats empty NO_COLOR as unset", () => {
    expect(shouldStyleHelp({ ...styledOn, env: { NO_COLOR: "" } })).toBe(true);
  });
});

describe("SGR helpers", () => {
  test("returns styled strings that contain SGR when applied", () => {
    // Given plain help tokens
    const title = "COMMON";
    const token = "start";
    const extra = "app:start";

    // When wrap helpers are applied
    const boldTitle = bold(title);
    const cyanToken = cyan(token);
    const dimExtra = dim(extra);
    const resetCode = reset();

    // Then each result is a string carrying CSI bytes around the original text
    expect(typeof boldTitle).toBe("string");
    expect(typeof cyanToken).toBe("string");
    expect(typeof dimExtra).toBe("string");
    expect(typeof resetCode).toBe("string");
    expect(boldTitle).toContain("\x1b[");
    expect(boldTitle).toContain(title);
    expect(cyanToken).toContain("\x1b[");
    expect(cyanToken).toContain(token);
    expect(dimExtra).toContain("\x1b[");
    expect(dimExtra).toContain(extra);
    expect(resetCode).toContain("\x1b[");
  });
});
