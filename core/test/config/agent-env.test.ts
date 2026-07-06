import { describe, expect, test } from "bun:test";

import {
  AGENT_CONTEXT_ENV_ALLOWLIST,
  filterHostProxyEnv,
  resolveAgentContextEnv,
  withAgentContextEnv,
} from "../../src/config/agent-env.ts";

describe("agent-context env allowlist", () => {
  test("is exactly the spec §6.9.1 built-in names, in order", () => {
    expect([...AGENT_CONTEXT_ENV_ALLOWLIST]).toEqual([
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CURSOR_AGENT",
      "OPENCODE",
      "COPILOT_CLI",
      "GEMINI_CLI",
      "AGENT",
      "CI",
    ]);
  });
});

describe("resolveAgentContextEnv — presence-gated selection", () => {
  test("forwards only allowlisted names that are set in the host env", () => {
    const resolved = resolveAgentContextEnv({
      CLAUDECODE: "1",
      CI: "true",
      HOME: "/home/aaron",
      SECRET_TOKEN: "shh",
    });
    expect(resolved).toEqual({ CLAUDECODE: "1", CI: "true" });
  });

  test("unset allowlisted names inject nothing (no empty-string vars)", () => {
    const resolved = resolveAgentContextEnv({ CLAUDECODE: undefined, AGENT: "codex" });
    expect(Object.hasOwn(resolved, "CLAUDECODE")).toBe(false);
    expect(resolved).toEqual({ AGENT: "codex" });
  });

  test("a set-but-empty allowlisted value is present (set, not unset)", () => {
    const resolved = resolveAgentContextEnv({ CI: "" });
    expect(Object.hasOwn(resolved, "CI")).toBe(true);
    expect(resolved.CI).toBe("");
  });

  test("never forwards a host name outside the allowlist", () => {
    const resolved = resolveAgentContextEnv({ CLAUDE_SECRET: "x", ANTHROPIC_API_KEY: "y" });
    expect(resolved).toEqual({});
  });

  test("reads fresh from the passed host env each call (never cached)", () => {
    expect(resolveAgentContextEnv({ OPENCODE: "1" })).toEqual({ OPENCODE: "1" });
    expect(resolveAgentContextEnv({ OPENCODE: undefined })).toEqual({});
  });
});

describe("withAgentContextEnv — lowest-precedence merge", () => {
  test("explicit env always wins over a forwarded agent value", () => {
    const merged = withAgentContextEnv({ CI: "explicit" }, { CI: "host", CLAUDECODE: "1" });
    expect(merged).toEqual({ CI: "explicit", CLAUDECODE: "1" });
  });

  test("service-declared env wins over a forwarded agent value", () => {
    const merged = withAgentContextEnv(
      undefined,
      { CI: "host", CLAUDECODE: "1" },
      { lowerThanEnv: { CI: "service" } },
    );
    expect(merged).toEqual({ CLAUDECODE: "1" });
  });

  test("explicit env still wins when service env also declares the marker", () => {
    const merged = withAgentContextEnv(
      { CI: "explicit" },
      { CI: "host", CLAUDECODE: "1" },
      { lowerThanEnv: { CI: "service" } },
    );
    expect(merged).toEqual({ CI: "explicit", CLAUDECODE: "1" });
  });

  test("forwarded markers fill in where explicit env is silent", () => {
    const merged = withAgentContextEnv({ APP_ENV: "dev" }, { AGENT: "codex" });
    expect(merged).toEqual({ APP_ENV: "dev", AGENT: "codex" });
  });

  test("returns undefined when nothing is forwarded and no explicit env is given", () => {
    expect(withAgentContextEnv(undefined, { HOME: "/home/aaron" })).toBeUndefined();
    expect(withAgentContextEnv({}, {})).toBeUndefined();
  });

  test("returns explicit env unchanged when no markers are present", () => {
    expect(withAgentContextEnv({ PORT: "8080" }, { HOME: "/home/aaron" })).toEqual({ PORT: "8080" });
  });
});

describe("filterHostProxyEnv — §10.10.3 shim filter with agent-context append", () => {
  test("keeps LANDO_*, LC_*, LANG, TERM and appends the agent-context allowlist", () => {
    const filtered = filterHostProxyEnv({
      LANDO_APP_NAME: "demo",
      LANDO_HOST_PROXY_TOKEN: "tok",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      CLAUDECODE: "1",
      CI: "true",
      HOME: "/home/aaron",
      PATH: "/usr/bin",
      SECRET_TOKEN: "shh",
    });
    expect(filtered).toEqual({
      LANDO_APP_NAME: "demo",
      LANDO_HOST_PROXY_TOKEN: "tok",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      CLAUDECODE: "1",
      CI: "true",
    });
  });

  test("drops container-leaked env that is neither a shim prefix/name nor an agent marker", () => {
    const filtered = filterHostProxyEnv({ HOME: "/root", AWS_SECRET_ACCESS_KEY: "leak" });
    expect(filtered).toEqual({});
  });

  test("skips unset values so no empty vars poison the host program", () => {
    const filtered = filterHostProxyEnv({ LANG: undefined, CI: "1" });
    expect(Object.hasOwn(filtered, "LANG")).toBe(false);
    expect(filtered).toEqual({ CI: "1" });
  });
});
