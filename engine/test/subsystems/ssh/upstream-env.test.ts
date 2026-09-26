import { describe, expect, test } from "bun:test";

import {
  LANDO_SSH_AGENT_UPSTREAM_ENV,
  applySshAgentUpstreamToProcessEnv,
  authoredSshAgentUpstreamFromEnv,
  envWithSshAgentUpstream,
  resolveAuthoredSshAgentUpstream,
  sshAgentUpstreamInstallRefusal,
} from "../../../src/subsystems/ssh/upstream-env.ts";

describe("ssh-agent upstream env bridge", () => {
  test("env overlay wins over config.yml", () => {
    expect(
      envWithSshAgentUpstream({ LANDO_SSH_AGENT_UPSTREAM: "host" }, { upstream: "/tmp/other.sock" }),
    ).toEqual({ LANDO_SSH_AGENT_UPSTREAM: "host" });
  });

  test("copies config.yml upstream when env is unset", () => {
    expect(envWithSshAgentUpstream({}, { upstream: "host" })).toEqual({
      LANDO_SSH_AGENT_UPSTREAM: "host",
    });
  });

  test("authored resolution is env, then config, then Landofile", () => {
    expect(
      resolveAuthoredSshAgentUpstream({
        env: { LANDO_SSH_AGENT_UPSTREAM: "host" },
        config: { upstream: "/tmp/config.sock" },
        landofile: { upstream: "/tmp/landofile.sock" },
      }),
    ).toBe("host");
    expect(
      resolveAuthoredSshAgentUpstream({
        env: {},
        config: { upstream: "/tmp/config.sock" },
        landofile: { upstream: "/tmp/landofile.sock" },
      }),
    ).toBe("/tmp/config.sock");
    expect(
      resolveAuthoredSshAgentUpstream({
        env: {},
        landofile: { upstream: "/tmp/landofile.sock" },
      }),
    ).toBe("/tmp/landofile.sock");
  });

  test("install refuses Windows and relative paths", () => {
    expect(sshAgentUpstreamInstallRefusal("host", "win32")?.message).toContain("not supported on Windows");
    expect(sshAgentUpstreamInstallRefusal("relative/agent.sock", "linux")?.message).toContain(
      "absolute Unix socket path",
    );
    expect(sshAgentUpstreamInstallRefusal("host", "linux")).toBeUndefined();
  });

  test("applySshAgentUpstreamToProcessEnv restores the previous value", () => {
    const env: Record<string, string | undefined> = {};
    const restore = applySshAgentUpstreamToProcessEnv({ upstream: "host" }, env);
    expect(env[LANDO_SSH_AGENT_UPSTREAM_ENV]).toBe("host");
    restore();
    expect(authoredSshAgentUpstreamFromEnv(env)).toBeUndefined();
  });
});
