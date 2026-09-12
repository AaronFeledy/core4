import { describe, expect, test } from "bun:test";

import { withTerminalEnv } from "../../src/config/terminal-env.ts";

describe("withTerminalEnv", () => {
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
