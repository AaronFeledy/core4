import { describe, expect, test } from "bun:test";

import { withTerminalEnv } from "../../src/config/terminal-env.ts";

describe("withTerminalEnv", () => {
  test.each([
    [true, true, "1"],
    [true, false, undefined],
    [true, undefined, undefined],
    [false, true, undefined],
  ] as const)("forwards color opt-out with tty=%j and noColor=%j", (tty, noColor, expected) => {
    // Given
    const hostTerminal = noColor === undefined ? {} : { noColor };
    // When
    const env = withTerminalEnv({ tty, hostTerminal });
    // Then
    expect(env?.NO_COLOR).toBe(expected);
  });

  test.each(["", "0", "service-value"])("preserves service NO_COLOR=%j", (value) => {
    // Given
    const serviceEnv = { NO_COLOR: value };
    // When
    const env = withTerminalEnv({ tty: true, hostTerminal: { noColor: true }, serviceEnv });
    // Then: the service already owns this key, so no exec override is emitted.
    expect(env).not.toHaveProperty("NO_COLOR");
  });

  test.each(["", "0", "explicit-value"])("preserves explicit NO_COLOR=%j", (value) => {
    // Given
    const env = { NO_COLOR: value };
    // When
    const result = withTerminalEnv({
      tty: true,
      hostTerminal: { noColor: true },
      serviceEnv: { NO_COLOR: "service-value" },
      env,
    });
    // Then
    expect(result?.NO_COLOR).toBe(value);
  });

  test.each([undefined, {}])("uses host dimensions without attached dimensions (%j)", (hostTerminal) => {
    // Given
    const hostEnv = { COLUMNS: "117", LINES: "39", TERM: "host-term", COLORTERM: "truecolor" };

    // When
    const env = withTerminalEnv({
      tty: true,
      hostEnv,
      ...(hostTerminal === undefined ? {} : { hostTerminal }),
    });

    // Then
    expect(env).toEqual({ COLUMNS: "117", LINES: "39" });
  });

  test("uses defaults when host dimensions are empty", () => {
    // When
    const env = withTerminalEnv({ tty: true, hostEnv: { COLUMNS: "", LINES: "" } });

    // Then
    expect(env).toEqual({ COLUMNS: "80", LINES: "24" });
  });

  test("adds only PTY dimensions when no terminal is attached", () => {
    // When
    const env = withTerminalEnv({ tty: true });

    // Then
    expect(env).toEqual({ COLUMNS: "80", LINES: "24" });
  });

  test("copies attached facts verbatim, including TERM=dumb", () => {
    // When
    const env = withTerminalEnv({
      tty: true,
      hostTerminal: { term: "dumb", colorterm: "truecolor", columns: 132, rows: 43 },
      hostEnv: { COLUMNS: "117", LINES: "39" },
    });

    // Then
    expect(env).toEqual({ COLUMNS: "132", LINES: "43", TERM: "dumb", COLORTERM: "truecolor" });
  });

  test("does not borrow terminal facts without PTY intent", () => {
    // When
    const env = withTerminalEnv({
      tty: false,
      hostTerminal: { term: "xterm-256color", colorterm: "truecolor", columns: 132, rows: 43 },
    });

    // Then
    expect(env).toBeUndefined();
  });

  test("keeps explicit env above service env above terminal defaults", () => {
    // When
    const env = withTerminalEnv({
      tty: true,
      hostTerminal: { term: "host-term", colorterm: "host-color", columns: 132, rows: 43 },
      serviceEnv: { TERM: "service-term", COLUMNS: "100" },
      env: { COLORTERM: "explicit-color", LINES: "50" },
    });

    // Then
    expect(env).toEqual({ COLORTERM: "explicit-color", LINES: "50" });
  });
});
