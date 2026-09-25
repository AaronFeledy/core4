import { expect, test } from "bun:test";
import { AbsolutePath, type AppId } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import { makeTestSshService } from "@lando/sdk/test";
import { Effect } from "effect";
import { sshAgentPostureCheck } from "../../src/cli/commands/doctor-ssh-agent.ts";

const SECURITY =
  "Services on apps that opt in can request signatures from this agent; private keys stay on the host.";

test("reports gpg detail when forward is enabled and omits exported key bytes", async () => {
  // Given
  const calls: string[][] = [];
  const runner: Pick<ProcessRunner["Type"], "run"> = {
    run: ({ cmd, args }) => {
      calls.push([cmd, ...args]);
      return Effect.succeed({
        exitCode: 0,
        stdout: cmd === "gpg" ? "PUBLIC-KEY-BYTES" : "/extra\n",
        stderr: "",
      });
    },
  };
  // When
  const check = await Effect.runPromise(
    sshAgentPostureCheck({
      globalConfig: { gpgAgent: { forward: true, socket: "/extra" } },
      platform: "linux",
      env: {},
      discovery: { home: "/home/test", exists: async () => true },
      capabilities: { agentSocket: { delivery: "bind-directory" } },
      sshService: {
        ...makeTestSshService(),
        id: "sidecar",
        getAgentSocket: (appId: AppId) =>
          Effect.succeed({ appId, socketPath: AbsolutePath.make("/test/agent.sock") }),
      },
      probe: async () => ({ identities: 0 }),
      gpgRunner: runner,
    }),
  );
  // Then
  expect(check.details?.gpg).toEqual({
    forward: true,
    upstream: { source: "explicit", reachable: true },
    keyringExported: true,
    security: SECURITY,
  });
  expect(calls).toEqual([["gpg", "--batch", "--export"]]);
  expect(calls.flat().some((arg) => arg.includes("--export-secret"))).toBe(false);
  expect(JSON.stringify(check)).not.toContain("PUBLIC-KEY-BYTES");
});

test("omits the gpg detail when forwarding is disabled", async () => {
  // Given
  const check = await Effect.runPromise(
    sshAgentPostureCheck({
      globalConfig: {},
      platform: "linux",
      env: {},
      discovery: { home: "/home/test", exists: async () => false },
      capabilities: { agentSocket: { delivery: "bind-directory" } },
      sshService: {
        ...makeTestSshService(),
        id: "sidecar",
        getAgentSocket: (appId: AppId) =>
          Effect.succeed({ appId, socketPath: AbsolutePath.make("/test/agent.sock") }),
      },
      probe: async () => ({ identities: 0 }),
    }),
  );
  // Then
  expect(check.details?.gpg).toBeUndefined();
});
