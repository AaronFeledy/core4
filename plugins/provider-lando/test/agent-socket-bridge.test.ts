import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineSshBridgeHost } from "@lando/container-runtime/podman/machine-ssh-bridge";
import { AbsolutePath, AppId, type HostPlatform, PortNumber } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makeRuntimeProvider } from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeFixture = async (platform: HostPlatform) => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-agent-bridge-test-"));
  directories.push(stateDir);
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  let closes = 0;
  const host: MachineSshBridgeHost = {
    which: (name) => name,
    run: async (command, args) => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        stdout:
          args[0] === "machine"
            ? JSON.stringify([
                {
                  Name: "lando",
                  State: "running",
                  Created: "2026-09-22T06:20:00Z",
                  SSHConfig: { IdentityPath: "/machine/identity", Port: 63397, RemoteUsername: "user" },
                },
              ])
            : args.at(-1) === 'printf %s "$HOME"'
              ? "/home/user"
              : "",
        stderr: "",
      };
    },
    start: (command, args) => {
      calls.push({ command, args });
      return {
        waitReady: async () => {},
        close: async () => {
          closes += 1;
        },
      };
    },
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      platform,
      arch: "arm64",
      providerSocketPath: "/managed/podman.sock",
      runtimeBinDir: "/managed/bin",
      stateDir,
      machineSshBridgeHost: host,
      sanitizeAppliedPlan: (plan) => plan,
    }),
  );
  return {
    provider,
    calls,
    get closes() {
      return closes;
    },
  };
};

describe("provider-lando agent socket bridge", () => {
  test.each([
    {
      name: "darwin bridge forwards a host unix socket into the managed machine",
      platform: "darwin",
      ssh: "ssh",
      config: "/dev/null",
      local: "/host/agent.sock",
      upstream: { _tag: "unix", path: "/host/agent.sock" },
    },
    {
      name: "win32 bridge forwards a loopback port",
      platform: "win32",
      ssh: "ssh.exe",
      config: "NUL",
      local: "127.0.0.1:49160",
      upstream: { _tag: "loopback-tcp", port: PortNumber.make(49160) },
    },
  ] as const)("$name", async ({ platform, ssh, config, local, upstream }) => {
    // Given: a managed provider with fake machine SSH process IO.
    const fixture = await makeFixture(platform);
    const bridge = fixture.provider.openAgentSocketBridge;
    expect(bridge).toBeDefined();
    if (bridge === undefined) throw new Error("Expected a managed agent socket bridge");
    // When: a scoped agent bridge is opened through the provider surface.
    const result = await Effect.runPromise(
      Effect.scoped(
        bridge({
          appId: AppId.make("my-app"),
          appRoot: AbsolutePath.make("/apps/my-app"),
          sessionId: "session",
          kind: "ssh",
          socketName: "agent.sock",
          upstream,
        }),
      ),
    );
    // Then: forwarding uses the managed machine and scope close releases its socket.
    expect(result._tag).toBe("bind-directory");
    if (result._tag !== "bind-directory") throw new Error("Expected a guest directory");
    expect(result.directory).toStartWith("/home/user/.local/share/lando/agent-socket/");
    expect(fixture.calls[0]).toEqual({
      command: platform === "win32" ? "/managed/bin/podman.exe" : "/managed/bin/podman",
      args: ["machine", "inspect", "lando"],
    });
    const forward = fixture.calls.find((call) => call.args.includes("-R"));
    expect(forward?.command).toBe(ssh);
    expect(forward?.args.slice(0, 2)).toEqual(["-F", config]);
    expect(forward?.args).toContain(`${result.directory}/agent.sock:${local}`);
    expect(fixture.calls.some((call) => call.args.at(-1)?.includes("chmod 666"))).toBe(true);
    expect(
      fixture.calls.some(
        (call) =>
          call.args.at(-1) === `rm -f -- ${result.directory}/agent.sock; rmdir -- ${result.directory}`,
      ),
    ).toBe(true);
    expect(fixture.closes).toBe(1);
    expect(typeof fixture.provider.openHostProxyBridge).toBe(platform === "win32" ? "function" : "undefined");
  });

  test.each([
    { platform: "linux", providerSocketPath: "/managed/podman.sock", stateDir: "/unused" },
    { platform: "wsl", providerSocketPath: "/managed/podman.sock", stateDir: "/unused" },
    { platform: "darwin", stateDir: "/unused" },
    { platform: "win32", stateDir: "/unused" },
    { platform: "darwin", providerSocketPath: "/managed/podman.sock" },
    { platform: "win32", providerSocketPath: "/managed/podman.sock" },
    {
      platform: "darwin",
      providerSocketPath: "/managed/podman.sock",
      socketPath: "/external.sock",
      stateDir: "/unused",
    },
    {
      platform: "win32",
      providerSocketPath: "/managed/podman.sock",
      socketPath: "/external.sock",
      stateDir: "/unused",
    },
  ] as const)("omits the machine bridge without managed machine prerequisites: %j", async (options) => {
    // Given: a native host, external runtime, or absent machine state directory.
    // When: the provider is constructed without touching a real runtime.
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        ...options,
        arch: "arm64",
        sanitizeAppliedPlan: (plan) => plan,
        podmanApi: { info: Effect.succeed({}), ping: Effect.void },
      }),
    );
    // Then: no machine bridge is exposed.
    expect(provider.openAgentSocketBridge).toBeUndefined();
  });
});
