import { describe, expect, test } from "bun:test";

import { HOST_PROXY_ENV_NAMES } from "../../src/config/agent-env.ts";
import {
  TERMINAL_CAPABILITY_ENV_ALLOWLIST,
  resolveTerminalCapabilityEnv,
} from "../../src/config/terminal-capability-env.ts";

describe("TERMINAL_CAPABILITY_ENV_ALLOWLIST", () => {
  test("is exactly the interactive TTY capability names, in order", () => {
    expect([...TERMINAL_CAPABILITY_ENV_ALLOWLIST]).toEqual([
      "TERM",
      "COLORTERM",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      "VTE_VERSION",
      "WT_SESSION",
      "KONSOLE_VERSION",
    ]);
  });

  test("is not folded into the host-proxy exact-name list", () => {
    expect([...HOST_PROXY_ENV_NAMES]).toEqual(["LANG", "TERM"]);
    expect(HOST_PROXY_ENV_NAMES).not.toContain("TERM_PROGRAM");
    expect(HOST_PROXY_ENV_NAMES).not.toContain("COLORTERM");
  });
});

describe("resolveTerminalCapabilityEnv — presence-gated selection", () => {
  test("forwards only allowlisted names that are set in the host env", () => {
    const resolved = resolveTerminalCapabilityEnv({
      TERM: "xterm-ghostty",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.2.0",
      VTE_VERSION: "6003",
      WT_SESSION: "session-id",
      KONSOLE_VERSION: "230800",
      HOST_SECRET: "shh",
      HOST_FOO: "nope",
      CI: "true",
    });
    expect(resolved).toEqual({
      TERM: "xterm-ghostty",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.2.0",
      VTE_VERSION: "6003",
      WT_SESSION: "session-id",
      KONSOLE_VERSION: "230800",
    });
  });

  test("unset allowlisted names inject nothing", () => {
    const resolved = resolveTerminalCapabilityEnv({ TERM: "xterm-256color", TERM_PROGRAM: undefined });
    expect(Object.hasOwn(resolved, "TERM_PROGRAM")).toBe(false);
    expect(resolved).toEqual({ TERM: "xterm-256color" });
  });

  test("a set-but-empty allowlisted value is present (set, not unset)", () => {
    const resolved = resolveTerminalCapabilityEnv({ COLORTERM: "" });
    expect(Object.hasOwn(resolved, "COLORTERM")).toBe(true);
    expect(resolved.COLORTERM).toBe("");
  });

  test("never forwards a host name outside the allowlist", () => {
    const resolved = resolveTerminalCapabilityEnv({
      HOST_SECRET: "x",
      HOST_FOO: "y",
      TERM_PROGRAM_NAME: "ghostty",
      FORCE_HYPERLINK: "1",
    });
    expect(resolved).toEqual({});
  });
});
