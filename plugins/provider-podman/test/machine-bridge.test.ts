import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineSshBridgeHost } from "@lando/container-runtime/podman/machine-ssh-bridge";
import { makeRuntimeProvider } from "@lando/provider-podman";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { Effect } from "effect";

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} bridge uses the default machine ssh metadata`, async () => {
    // Given a non-first default machine with distinct SSH metadata.
    const stateDir = await mkdtemp(join(tmpdir(), "podman-agent-test-"));
    const calls: { readonly command: string; readonly args: readonly string[] }[] = [];
    const started: { readonly command: string; readonly args: readonly string[] }[] = [];
    let closed = false;
    const host: MachineSshBridgeHost = {
      which: (name) => name,
      run: async (command, args) => {
        calls.push({ command, args });
        const stdout =
          args[1] === "list"
            ? JSON.stringify([
                { Name: "other", Default: false },
                { Name: "chosen", Default: true },
              ])
            : args[1] === "inspect"
              ? JSON.stringify([
                  {
                    Name: "chosen",
                    State: "running",
                    Created: "2026-01-01",
                    SSHConfig: { IdentityPath: "/keys/chosen", Port: 2244, RemoteUsername: "alice" },
                  },
                ])
              : args.at(-1) === 'printf %s "$HOME"'
                ? "/home/alice"
                : "";
        return { exitCode: 0, stdout, stderr: "" };
      },
      start: (command, args) => {
        started.push({ command, args });
        return {
          waitReady: async () => {},
          close: async () => {
            closed = true;
          },
        };
      },
    };
    try {
      // When the provider opens and releases a scoped bridge.
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const provider = yield* makeRuntimeProvider({
              platform,
              env: {},
              stateDir,
              agentBridgeHost: host,
              conflictDetector: () => Effect.void,
              podmanApi: { ping: Effect.void, info: Effect.succeed({ version: { Version: "6.0.2" } }) },
            });
            const open = provider.openAgentSocketBridge;
            if (open === undefined) throw new Error("Agent socket bridge is missing");
            return yield* open({
              appId: AppId.make("demo"),
              appRoot: AbsolutePath.make("/apps/demo"),
              sessionId: "session",
              kind: "ssh",
              socketName: "agent.sock",
              upstream:
                platform === "win32"
                  ? { _tag: "loopback-tcp", port: 32123 }
                  : { _tag: "unix", path: "/tmp/relay.sock" },
            });
          }),
        ),
      );
      // Then selection, SSH authentication, forwarding and cleanup use that machine.
      expect(calls[0]).toEqual({ command: "podman", args: ["machine", "list", "--format", "json"] });
      expect(calls).toContainEqual({ command: "podman", args: ["machine", "inspect", "chosen"] });
      expect(started).toHaveLength(1);
      expect(started[0]?.command).toBe(platform === "win32" ? "ssh.exe" : "ssh");
      expect(started[0]?.args).toContain("/keys/chosen");
      expect(started[0]?.args).toContain("2244");
      expect(started[0]?.args).toContain("alice@127.0.0.1");
      expect(result._tag).toBe("bind-directory");
      if (result._tag === "bind-directory") {
        expect(started[0]?.args).toContain(
          `${result.directory}/agent.sock:${platform === "win32" ? "127.0.0.1:32123" : "/tmp/relay.sock"}`,
        );
      }
      expect(closed).toBe(true);
      expect(calls.at(-1)?.args.at(-1)).toContain("rmdir -- /home/alice/.local/share/lando/agent-socket/");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
