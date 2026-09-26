import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";

import { runSshAgentUpstreamDoctorCheck } from "../src/doctor.ts";
import { plugin } from "../src/index.ts";
import { SSH_AGENT_UPSTREAM_FALLBACK_WARNING, SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE } from "../src/upstream.ts";

const baseInput = (
  env: Readonly<Record<string, string | undefined>>,
  platform: PluginDoctorCheckInput["platform"] = "linux",
): PluginDoctorCheckInput => ({
  providerId: "lando",
  platform,
  env,
  userDataRoot: "/tmp/lando-user-data",
  binDir: undefined,
  stateDir: undefined,
});

describe("ssh-agent upstream doctor check", () => {
  test("plugin contributes the upstream doctor check", () => {
    expect(plugin.doctorChecks?.map((check) => check.id)).toEqual(["ssh-agent-upstream"]);
  });

  test("stays quiet when upstream is unset", async () => {
    const reports = await Effect.runPromise(runSshAgentUpstreamDoctorCheck(baseInput({})));
    expect(reports).toEqual([]);
  });

  test("mentions the upstream sock when host mode has a live socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-ssh-agent-doctor-"));
    const socketPath = join(dir, "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    try {
      const reports = await Effect.runPromise(
        runSshAgentUpstreamDoctorCheck(
          baseInput({
            LANDO_SSH_AGENT_UPSTREAM: "host",
            SSH_AUTH_SOCK: socketPath,
          }),
        ),
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]?.name).toBe("ssh-agent-upstream");
      expect(reports[0]?.status).toBe("pass");
      expect(reports[0]?.context.upstream).toBe("host");
      expect(reports[0]?.context.upstreamSock).toBe(socketPath);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("warns with the fallback message when the host socket is missing", async () => {
    const reports = await Effect.runPromise(
      runSshAgentUpstreamDoctorCheck(baseInput({ LANDO_SSH_AGENT_UPSTREAM: "host" })),
    );
    expect(reports[0]?.status).toBe("warn");
    expect(reports[0]?.solutions[0]?.description).toBe(SSH_AGENT_UPSTREAM_FALLBACK_WARNING);
    expect(reports[0]?.context.upstream).toBe("host");
  });

  test("fails on Windows with remediation", async () => {
    const reports = await Effect.runPromise(
      runSshAgentUpstreamDoctorCheck(baseInput({ LANDO_SSH_AGENT_UPSTREAM: "host" }, "win32")),
    );
    expect(reports[0]?.status).toBe("fail");
    expect(reports[0]?.solutions[0]?.description).toContain(SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE);
    expect(reports[0]?.solutions[0]?.description).toContain("Unset sshAgent.upstream");
  });
});
