import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AgentSocketBridgeInput, AppId, PortNumber } from "@lando/sdk/schema";
import { Effect, Either } from "effect";
import { type MachineSshBridgeHost, makeMachineSshBridge } from "../src/podman/machine-ssh-bridge.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async (sshBinary: "ssh" | "ssh.exe" = "ssh", readyError?: Error) => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-agent-bridge-"));
  directories.push(stateDir);
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const events: string[] = [];
  const host: MachineSshBridgeHost = {
    which: (name) => name,
    run: async (command, args) => {
      calls.push({ command, args });
      events.push(args.at(-1) ?? "");
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          command === "podman"
            ? JSON.stringify([
                {
                  Name: "test-machine",
                  State: "running",
                  Created: "2026-09-22",
                  SSHConfig: { IdentityPath: "/identity", Port: 63397, RemoteUsername: "user" },
                },
              ])
            : args.at(-1) === 'printf %s "$HOME"'
              ? "/home/user"
              : "",
      };
    },
    start: (command, args) => {
      calls.push({ command, args });
      events.push("start");
      return {
        waitReady: async () => {
          if (readyError !== undefined) throw readyError;
          events.push("ready");
        },
        close: async () => {
          events.push("close");
        },
      };
    },
  };
  return {
    calls,
    events,
    bridge: makeMachineSshBridge({
      podmanBin: "podman",
      machineName: "test-machine",
      stateDir,
      sshBinary,
      providerId: "podman",
      host,
    }),
  };
};

const input = {
  appId: AppId.make("my-app"),
  appRoot: AbsolutePath.make("/apps/my-app"),
  sessionId: "first",
  kind: "ssh",
  socketName: "agent.sock",
  upstream: { _tag: "unix", path: "/tmp/host agent.sock" },
} satisfies AgentSocketBridgeInput;
const directory = (session: string) =>
  `/home/user/.local/share/lando/agent-socket/${createHash("sha256").update(`my-app/${session}`).digest("hex").slice(0, 32)}`;

test("agent socket bridge reverse-forwards a unix upstream into a session-unique guest directory", async () => {
  // Given: a machine with a host Unix agent and two independent sessions.
  const f = await fixture();
  // When: both session bridges are opened.
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.all([
        f.bridge.openAgentSocketBridge(input),
        f.bridge.openAgentSocketBridge({ ...input, sessionId: "second" }),
      ]),
    ),
  );
  // Then: each mount and reverse forward names its own hashed guest directory.
  expect(results).toEqual([
    { _tag: "bind-directory", directory: AbsolutePath.make(directory("first")) },
    { _tag: "bind-directory", directory: AbsolutePath.make(directory("second")) },
  ]);
  const forwards = f.calls.filter((call) => call.args.includes("-R"));
  expect(forwards.map((call) => call.args[call.args.indexOf("-R") + 1])).toEqual([
    `${directory("first")}/agent.sock:/tmp/host agent.sock`,
    `${directory("second")}/agent.sock:/tmp/host agent.sock`,
  ]);
  expect(forwards[0]?.args).toContain("/dev/null");
  expect(f.events.findIndex((event) => event.includes("rm -f --"))).toBeLessThan(f.events.indexOf("start"));
  expect(f.events.findIndex((event) => event.includes("chmod 666"))).toBeGreaterThan(
    f.events.indexOf("ready"),
  );
  expect(f.events.some((event) => event.includes("mkdir -m 711 --"))).toBe(true);
  expect(
    f.events.some((event) => event.includes("chmod 711 -- /home/user/.local/share/lando/agent-socket")),
  ).toBe(true);
});

test("agent socket bridge reverse-forwards a loopback tcp upstream on windows", async () => {
  // Given: a Windows host broker listening on loopback.
  const f = await fixture("ssh.exe");
  // When: the agent bridge opens.
  await Effect.runPromise(
    Effect.scoped(
      f.bridge.openAgentSocketBridge({
        ...input,
        upstream: { _tag: "loopback-tcp", port: PortNumber.make(49160) },
      }),
    ),
  );
  // Then: Windows OpenSSH forwards the guest socket to that port.
  const forward = f.calls.find((call) => call.args.includes("-R"));
  expect(forward?.command).toBe("ssh.exe");
  expect(forward?.args).toContain("NUL");
  expect(forward?.args).toContain(`${directory("first")}/agent.sock:127.0.0.1:49160`);
});

test("scope close removes the guest socket and directory", async () => {
  // Given: a machine bridge scoped to this operation.
  const f = await fixture();
  // When: its scope closes.
  await Effect.runPromise(Effect.scoped(f.bridge.openAgentSocketBridge(input)));
  // Then: SSH closes before guest cleanup removes only that session's paths.
  expect(f.events.filter((event) => event === "close")).toHaveLength(1);
  expect(f.events.at(-1)).toBe(`rm -f -- ${directory("first")}/agent.sock; rmdir -- ${directory("first")}`);
  expect(f.events.at(-2)).toBe("close");
});

test("readiness failure closes SSH and reports the selected provider", async () => {
  // Given: SSH rejects the forward.
  const f = await fixture("ssh", new Error("forward rejected"));
  // When: the bridge is acquired.
  const result = await Effect.runPromise(Effect.either(Effect.scoped(f.bridge.openAgentSocketBridge(input))));
  // Then: the provider failure is actionable and partial resources are released.
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left.providerId).toBe("podman");
    expect(result.left.remediation).toContain("lando setup --provider=podman");
  }
  expect(f.events).toContain("close");
  expect(f.events.at(-1)).toContain("rmdir --");
});
