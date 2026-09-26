import { describe, expect, test } from "bun:test";

import {
  LANDO_SSH_AGENT_UPSTREAM_ENV,
  applySshAgentUpstreamToProcessEnv,
  authoredSshAgentUpstreamFromEnv,
  envWithSshAgentUpstream,
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

  test("applySshAgentUpstreamToProcessEnv restores the previous value", () => {
    const env: Record<string, string | undefined> = {};
    const restore = applySshAgentUpstreamToProcessEnv({ upstream: "host" }, env);
    expect(env[LANDO_SSH_AGENT_UPSTREAM_ENV]).toBe("host");
    restore();
    expect(authoredSshAgentUpstreamFromEnv(env)).toBeUndefined();
  });
});
