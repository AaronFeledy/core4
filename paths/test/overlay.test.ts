import { describe, expect, test } from "bun:test";

import { envOverlay } from "../src/overlay.ts";

describe("env overlay friendly aliases", () => {
  test("LANDO_SSH_AGENT_UPSTREAM maps to sshAgent.upstream", () => {
    expect(envOverlay({ LANDO_SSH_AGENT_UPSTREAM: "host" })).toEqual({
      sshAgent: { upstream: "host" },
    });
  });
});
