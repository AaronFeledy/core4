import { describe, expect, test } from "bun:test";

import {
  SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
  SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE,
  SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
  SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
  authoredUpstreamFromEnv,
  resolveSshAgentUpstream,
} from "../src/upstream.ts";

describe("authoredUpstreamFromEnv", () => {
  test("prefers the friendly env over the config overlay", () => {
    expect(
      authoredUpstreamFromEnv({
        LANDO_SSH_AGENT_UPSTREAM: "host",
        LANDO_CONFIG__ssh_agent__upstream: "/tmp/other.sock",
      }),
    ).toBe("host");
  });
});

describe("resolveSshAgentUpstream", () => {
  test("unset keeps file-load even when SSH_AUTH_SOCK is set", () => {
    expect(
      resolveSshAgentUpstream({
        sshAuthSock: "/tmp/agent.sock",
        platform: "linux",
        isSocket: () => true,
      }),
    ).toEqual({ kind: "file-load" });
  });

  test("host with a live Unix socket relays that path", () => {
    expect(
      resolveSshAgentUpstream({
        upstream: "host",
        sshAuthSock: "/tmp/agent.sock",
        platform: "linux",
        isSocket: (path) => path === "/tmp/agent.sock",
      }),
    ).toEqual({
      kind: "upstream",
      socketPath: "/tmp/agent.sock",
      requested: "host",
    });
  });

  test("absolute socket path relays that path", () => {
    expect(
      resolveSshAgentUpstream({
        upstream: "/run/user/1000/ssh-agent.sock",
        platform: "darwin",
        isSocket: () => true,
      }),
    ).toEqual({
      kind: "upstream",
      socketPath: "/run/user/1000/ssh-agent.sock",
      requested: "/run/user/1000/ssh-agent.sock",
    });
  });

  test("missing host socket warns and falls back to file-load", () => {
    const resolution = resolveSshAgentUpstream({
      upstream: "host",
      platform: "linux",
      isSocket: () => false,
    });
    expect(resolution.kind).toBe("fallback");
    if (resolution.kind !== "fallback") return;
    expect(resolution.warning).toBe(SSH_AGENT_UPSTREAM_FALLBACK_WARNING);
    expect(resolution.warning).toContain("passphrase-protected keys");
    expect(resolution.warning).toContain("Keys that live only in an SSH agent");
  });

  test("Windows upstream is unsupported", () => {
    const resolution = resolveSshAgentUpstream({
      upstream: "host",
      sshAuthSock: "\\\\.\\pipe\\openssh-ssh-agent",
      platform: "win32",
      isSocket: () => false,
    });
    expect(resolution).toEqual({
      kind: "unsupported",
      requested: "host",
      reason: "windows",
      message: SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
      remediation: SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
    });
  });

  test("relative path is invalid", () => {
    expect(
      resolveSshAgentUpstream({
        upstream: "relative/agent.sock",
        platform: "linux",
      }),
    ).toEqual({
      kind: "invalid",
      requested: "relative/agent.sock",
      message: SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE,
    });
  });
});
