import { describe, expect, test } from "bun:test";

import {
  AGENT_CONTEXT_ENV_ALLOWLIST,
  AGENT_ENV_DISABLE_ENV_VAR,
  filterHostProxyEnv,
  findAgentEnvPatternNames,
  isAgentEnvForwardingDisabled,
  isExactAgentEnvName,
  resolveAgentContextEnv,
  resolveAgentEnvAllowlist,
  withAgentContextEnv,
} from "../../src/config/agent-env.ts";

describe("agent-context env allowlist", () => {
  test("is exactly the built-in names, in order", () => {
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

describe("isExactAgentEnvName / findAgentEnvPatternNames — exact-name validation", () => {
  test("accepts POSIX-shaped exact env names", () => {
    expect(isExactAgentEnvName("CLAUDECODE")).toBe(true);
    expect(isExactAgentEnvName("MY_VAR_1")).toBe(true);
    expect(isExactAgentEnvName("_leading")).toBe(true);
  });

  test("rejects wildcards and pattern syntax", () => {
    expect(isExactAgentEnvName("CLAUDE_*")).toBe(false);
    expect(isExactAgentEnvName("*")).toBe(false);
    expect(isExactAgentEnvName("A?B")).toBe(false);
    expect(isExactAgentEnvName("1STARTS_WITH_DIGIT")).toBe(false);
    expect(isExactAgentEnvName("has space")).toBe(false);
    expect(isExactAgentEnvName("")).toBe(false);
  });

  test("findAgentEnvPatternNames returns only the offending pattern names, in order", () => {
    expect(findAgentEnvPatternNames(["FOO", "CLAUDE_*", "BAR", "X-Y"])).toEqual(["CLAUDE_*", "X-Y"]);
    expect(findAgentEnvPatternNames(["FOO", "BAR"])).toEqual([]);
  });
});

describe("isAgentEnvForwardingDisabled — master switch / opt-out / per-invocation", () => {
  test("disabled when global enabled is false", () => {
    expect(isAgentEnvForwardingDisabled({ enabled: false }, {})).toBe(true);
  });

  test("disabled when the app opts out via Landofile agentEnv:false", () => {
    expect(isAgentEnvForwardingDisabled({ appOptOut: true }, {})).toBe(true);
  });

  test("disabled when LANDO_AGENT_ENV=0 for a single invocation", () => {
    expect(AGENT_ENV_DISABLE_ENV_VAR).toBe("LANDO_AGENT_ENV");
    expect(isAgentEnvForwardingDisabled({}, { LANDO_AGENT_ENV: "0" })).toBe(true);
  });

  test("enabled by default and for any non-zero LANDO_AGENT_ENV value", () => {
    expect(isAgentEnvForwardingDisabled({}, {})).toBe(false);
    expect(isAgentEnvForwardingDisabled({ enabled: true }, { LANDO_AGENT_ENV: "1" })).toBe(false);
  });
});

describe("resolveAgentEnvAllowlist — built-ins + allow − deny with disable short-circuits", () => {
  test("returns the built-in allowlist when no policy is configured", () => {
    expect([...resolveAgentEnvAllowlist({}, {})]).toEqual([...AGENT_CONTEXT_ENV_ALLOWLIST]);
  });

  test("adds allow names after the built-ins and removes deny names", () => {
    const resolved = resolveAgentEnvAllowlist({ allow: ["FOO_TOKEN"], deny: ["CI"] }, {});
    expect(resolved).toContain("FOO_TOKEN");
    expect(resolved).not.toContain("CI");
    expect(resolved).toContain("CLAUDECODE");
    expect(resolved[resolved.length - 1]).toBe("FOO_TOKEN");
  });

  test("deny wins over allow for the same name", () => {
    expect(resolveAgentEnvAllowlist({ allow: ["CI"], deny: ["CI"] }, {})).not.toContain("CI");
  });

  test("silently drops wildcard allow entries (already rejected at config validation)", () => {
    const resolved = resolveAgentEnvAllowlist({ allow: ["CLAUDE_*", "GOOD_NAME"] }, {});
    expect(resolved).not.toContain("CLAUDE_*");
    expect(resolved).toContain("GOOD_NAME");
  });

  test("returns an empty allowlist when forwarding is disabled by any switch", () => {
    expect(resolveAgentEnvAllowlist({ enabled: false, allow: ["FOO"] }, {})).toEqual([]);
    expect(resolveAgentEnvAllowlist({ appOptOut: true }, {})).toEqual([]);
    expect(resolveAgentEnvAllowlist({}, { LANDO_AGENT_ENV: "0" })).toEqual([]);
  });

  test("never contains duplicates when an allow name repeats a built-in", () => {
    const resolved = resolveAgentEnvAllowlist({ allow: ["CI"] }, {});
    expect(resolved.filter((name) => name === "CI")).toHaveLength(1);
  });
});

describe("filterHostProxyEnv — shim filter with agent-context append", () => {
  test("keeps safe LANDO_*, LC_*, LANG, TERM and appends the agent-context allowlist", () => {
    const filtered = filterHostProxyEnv({
      LANDO_APP_NAME: "demo",
      LANDO_HOST_PROXY_TOKEN: "tok",
      LANDO_HOST_PROXY_SESSION: "session",
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_URL: "http://127.0.0.1:1234",
      LANDO_HOST_PROXY_APP: "demo",
      LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      LANDO_HOST_PROXY_SHIM: "/usr/local/bin/lando",
      LANDO_HOST_PROXY_DEPTH: "7",
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
