import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { type HostProxyBridgeHost, makeWindowsHostProxyBridge } from "../src/host-proxy-bridge.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeFixture = async (readyError?: Error) => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-bridge-test-"));
  directories.push(stateDir);
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let closes = 0;
  const host: HostProxyBridgeHost = {
    which: () => "ssh.exe",
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "podman.exe") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: "lando",
              State: "running",
              Created: "2026-09-22T06:20:00Z",
              SSHConfig: { IdentityPath: "C:\\machine\\identity", Port: 63397, RemoteUsername: "user" },
            },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: args.at(-1) === 'printf %s "$HOME"' ? "/home/user" : "", stderr: "" };
    },
    start: (command, args) => {
      calls.push({ command, args });
      return {
        waitReady: () => (readyError === undefined ? Promise.resolve() : Promise.reject(readyError)),
        close: async () => {
          closes += 1;
        },
      };
    },
  };
  return {
    bridge: makeWindowsHostProxyBridge({ podmanBin: "podman.exe", stateDir, machineName: "lando", host }),
    calls,
    get closes() {
      return closes;
    },
  };
};

describe("managed Windows host-proxy guest bridge", () => {
  test("opens a session-unique private socket and closes the reverse forward with its scope", async () => {
    const fixture = await makeFixture();
    const first = await Effect.runPromise(
      Effect.scoped(
        fixture.bridge({
          appId: AppId.make("my-app"),
          sessionId: "first",
          loopbackUrl: "http://127.0.0.1:49160",
        }),
      ),
    );
    const second = await Effect.runPromise(
      Effect.scoped(
        fixture.bridge({
          appId: AppId.make("my-app"),
          sessionId: "second",
          loopbackUrl: "http://127.0.0.1:49160",
        }),
      ),
    );
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.socketPath).toStartWith("/home/user/.local/share/lando/host-proxy/");
    const forwards = fixture.calls.filter((call) => call.args.includes("-R"));
    expect(forwards).toHaveLength(2);
    expect(forwards[0]?.args.find((arg) => arg.includes(":127.0.0.1:49160"))).toBe(
      `${first.socketPath}:127.0.0.1:49160`,
    );
    expect(forwards[0]?.args).toContain("ExitOnForwardFailure=yes");
    expect(fixture.calls.some((call) => call.args.at(-1)?.includes("chmod 666"))).toBe(true);
    expect(fixture.calls.filter((call) => call.args.at(-1)?.includes("rmdir --"))).toHaveLength(2);
    expect(fixture.closes).toBe(2);
  });

  test("fails closed and removes its own socket when forwarding cannot become ready", async () => {
    const fixture = await makeFixture(new Error("forward rejected"));
    const outcome = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          fixture.bridge({
            appId: AppId.make("my-app"),
            sessionId: "failed",
            loopbackUrl: "http://127.0.0.1:49160",
          }),
        ),
      ),
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left._tag).toBe("ProviderUnavailableError");
    expect(fixture.closes).toBe(1);
    expect(fixture.calls.some((call) => call.args.at(-1)?.includes("rmdir --"))).toBe(true);
  });
});
