import { expect, test } from "bun:test";
import { Effect } from "effect";

test("prefers explicit socket, then SSH_AUTH_SOCK, then 1Password path per platform", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  for (const platform of ["linux", "darwin"] as const) {
    // Given
    const options = {
      platform,
      home: "/home/test",
      env: { SSH_AUTH_SOCK: "/env" },
      exists: async () => true,
    };
    // When
    const explicit = await Effect.runPromise(
      discoverHostSshAgent({ ...options, explicitSocket: "/explicit" }),
    );
    const env = await Effect.runPromise(discoverHostSshAgent(options));
    const password = await Effect.runPromise(discoverHostSshAgent({ ...options, env: {} }));
    // Then
    expect(explicit).toMatchObject({ source: "explicit", path: "/explicit" });
    expect(env).toMatchObject({ source: "env", path: "/env" });
    expect(password).toMatchObject({
      source: "1password",
      path:
        platform === "linux"
          ? "/home/test/.1password/agent.sock"
          : "/home/test/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    });
  }
});

test("win32 falls back to the OpenSSH named pipe", async () => {
  // Given
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // When
  const result = await Effect.runPromise(
    discoverHostSshAgent({ platform: "win32", home: "C:\\Users\\test", env: {}, exists: async () => false }),
  );
  // Then
  expect(result).toEqual({
    _tag: "named-pipe",
    path: String.raw`\\.\pipe\openssh-ssh-agent`,
    source: "windows-openssh",
  });
});

test("fails host-agent-not-found with remediation", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given / When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostSshAgent({ platform: "linux", home: "/home/test", env: {}, exists: async () => false }),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "SshAgentUnavailableError",
      reason: "host-agent-not-found",
      remediation: expect.stringContaining("SSH_AUTH_SOCK"),
    },
  });
});

test("missing explicit socket fails without falling back", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given / When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostSshAgent({
        platform: "linux",
        home: "/home/test",
        env: { SSH_AUTH_SOCK: "/env" },
        explicitSocket: "/missing",
        exists: async (path) => path !== "/missing",
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "socket-missing", socketPath: "/missing" } });
});

test("gpg precedes yubikey-agent and absent gpg falls through", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given
  const options = {
    platform: "linux" as const,
    home: "/home/test",
    env: { XDG_RUNTIME_DIR: "/run/user/test" },
    exists: async (path: string) => path === "/gpg" || path.includes("yubikey-agent"),
  };
  // When
  const gpg = await Effect.runPromise(discoverHostSshAgent({ ...options, runGpgconf: async () => "/gpg\n" }));
  const yubikey = await Effect.runPromise(discoverHostSshAgent(options));
  // Then
  expect(gpg).toMatchObject({ source: "gpg", path: "/gpg" });
  expect(yubikey).toMatchObject({ source: "yubikey-agent" });
});

test("missing gpgconf executable does not hide a yubikey agent", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given
  const options = {
    platform: "linux",
    home: "/home/test",
    env: { XDG_RUNTIME_DIR: "/run/user/test" },
    exists: async (path: string) => path.includes("yubikey-agent"),
    runGpgconf: async (): Promise<string> => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  // When
  const result = await Effect.runPromise(discoverHostSshAgent(options));
  // Then
  expect(result.source).toBe("yubikey-agent");
});
