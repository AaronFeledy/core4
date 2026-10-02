import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppId } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import { makeTestSshService } from "@lando/sdk/test";
import { Effect } from "effect";
import { sshAgentPostureCheck } from "../../src/cli/commands/doctor-ssh-agent.ts";

const SECURITY =
  "Services on apps that opt in can request signatures from this agent; private keys stay on the host.";

const recordingRunner = (calls: string[][]): Pick<ProcessRunner["Type"], "run"> => ({
  run: ({ cmd, args }) => {
    calls.push([cmd, ...args]);
    return Effect.succeed({
      exitCode: 0,
      stdout: cmd === "gpg" ? "PUBLIC-KEY-BYTES" : "/extra\n",
      stderr: "",
    });
  },
});
const sshService = {
  ...makeTestSshService(),
  id: "sidecar",
  getAgentSocket: (appId: AppId) =>
    Effect.succeed({ appId, socketPath: AbsolutePath.make("/test/agent.sock") }),
};
const restrictedAgent = () =>
  createServer((socket) => {
    socket.write("OK Pleased to meet you\n");
    socket.once("data", () => socket.write("OK\n"));
  });
const listen = (server: Server, path: string) => new Promise<void>((resolve) => server.listen(path, resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("reports gpg detail when forward is enabled and omits exported key bytes", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "doctor-gpg-"));
  const socket = join(root, "S.gpg-agent.extra");
  const server = restrictedAgent();
  await listen(server, socket);
  const calls: string[][] = [];
  try {
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        globalConfig: { gpgAgent: { forward: true, socket } },
        platform: "linux",
        env: {},
        discovery: { home: "/home/test", exists: async () => true },
        capabilities: { agentSocket: { delivery: "bind-directory" } },
        sshService,
        probe: async () => ({ identities: 0 }),
        gpgRunner: recordingRunner(calls),
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
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor never launches gpg-agent when the socket is missing", async () => {
  // Given
  const calls: string[][] = [];
  // When
  const check = await Effect.runPromise(
    sshAgentPostureCheck({
      globalConfig: { gpgAgent: { forward: true, socket: "/nowhere/S.gpg-agent.extra" } },
      platform: "linux",
      env: {},
      discovery: { home: "/home/test", exists: async () => false },
      capabilities: { agentSocket: { delivery: "bind-directory" } },
      sshService,
      probe: async () => ({ identities: 0 }),
      gpgRunner: recordingRunner(calls),
    }),
  );
  // Then
  expect(check.details?.gpg).toMatchObject({ forward: true, upstream: { source: "none", reachable: false } });
  expect(calls.some((call) => call.includes("--launch"))).toBe(false);
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
      sshService,
      probe: async () => ({ identities: 0 }),
    }),
  );
  // Then
  expect(check.details?.gpg).toBeUndefined();
});
