import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

const alive = () => Effect.succeed({ identities: 0 });

const listen = async (path: string): Promise<{ readonly close: () => Promise<void> }> => {
  const server = createServer((socket) =>
    socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
};

test("prefers explicit socket, then SSH_AUTH_SOCK, then 1Password path per platform", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  for (const platform of ["linux", "darwin"] as const) {
    // Given
    const options = {
      platform,
      home: "/home/test",
      env: { SSH_AUTH_SOCK: "/env" },
      exists: async () => true,
      probe: alive,
    };
    // When
    const explicit = await Effect.runPromise(
      discoverHostSshAgent({ ...options, explicitSocket: "/explicit" }),
    );
    const env = await Effect.runPromise(discoverHostSshAgent(options));
    const password = await Effect.runPromise(discoverHostSshAgent({ ...options, env: {} }));
    // Then
    expect(explicit.upstream).toMatchObject({ source: "explicit", path: "/explicit" });
    expect(env.upstream).toMatchObject({ source: "env", path: "/env" });
    expect(password.upstream).toMatchObject({
      source: "1password",
      path:
        platform === "linux"
          ? "/home/test/.1password/agent.sock"
          : "/home/test/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    });
  }
});

test("win32 falls back to the OpenSSH named pipe when it answers", async () => {
  // Given
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  const probed: string[] = [];
  // When
  const result = await Effect.runPromise(
    discoverHostSshAgent({
      platform: "win32",
      home: "C:\\Users\\test",
      env: {},
      exists: async () => false,
      probe: (upstream) => {
        if (upstream._tag === "named-pipe") probed.push(upstream.path);
        return Effect.succeed({ identities: 1 });
      },
    }),
  );
  // Then
  expect(result.upstream).toEqual({
    _tag: "named-pipe",
    path: String.raw`\\.\pipe\openssh-ssh-agent`,
    source: "windows-openssh",
  });
  expect(result.identities).toBe(1);
  expect(probed).toEqual([String.raw`\\.\pipe\openssh-ssh-agent`]);
});

test("win32 does not select a named pipe that refuses the identities probe", async () => {
  // Given
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostSshAgent({
        platform: "win32",
        home: "C:\\Users\\test",
        env: {},
        exists: async () => false,
        probe: () => Effect.fail("refused"),
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { reason: "host-agent-not-found" },
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
        probe: alive,
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
    probe: alive,
  };
  // When
  const gpg = await Effect.runPromise(discoverHostSshAgent({ ...options, runGpgconf: async () => "/gpg\n" }));
  const yubikey = await Effect.runPromise(discoverHostSshAgent(options));
  // Then
  expect(gpg.upstream).toMatchObject({ source: "gpg", path: "/gpg" });
  expect(yubikey.upstream).toMatchObject({ source: "yubikey-agent" });
});

test("missing gpgconf executable does not hide a yubikey agent", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given
  const options = {
    platform: "linux",
    home: "/home/test",
    env: { XDG_RUNTIME_DIR: "/run/user/test" },
    exists: async (path: string) => path.includes("yubikey-agent"),
    probe: alive,
    runGpgconf: async (): Promise<string> => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  // When
  const result = await Effect.runPromise(discoverHostSshAgent(options));
  // Then
  expect(result.upstream.source).toBe("yubikey-agent");
});

test("stale SSH_AUTH_SOCK falls through to a live 1Password agent", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a regular file at SSH_AUTH_SOCK and a live agent at the 1Password socket.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-fallthrough-"));
  const stale = join(root, "stale.sock");
  const password = join(root, ".1password", "agent.sock");
  await mkdir(join(root, ".1password"));
  await writeFile(stale, "not-a-socket");
  const agent = await listen(password);
  try {
    // When discovery runs without an explicit socket.
    const result = await Effect.runPromise(
      discoverHostSshAgent({
        platform: "linux",
        home: root,
        env: { SSH_AUTH_SOCK: stale },
      }),
    );
    // Then the live 1Password agent is selected.
    expect(result.upstream).toMatchObject({ source: "1password", path: password, _tag: "unix" });
    expect(result.identities).toBe(0);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit symlink is socket-missing and does not fall through", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given an explicit symlink to a live agent and another live SSH_AUTH_SOCK.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-symlink-"));
  const live = join(root, "live.sock");
  const link = join(root, "link.sock");
  const agent = await listen(live);
  await symlink(live, link);
  try {
    // When the explicit socket is that symlink.
    const result = await Effect.runPromise(
      Effect.either(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: { SSH_AUTH_SOCK: live },
          explicitSocket: link,
        }),
      ),
    );
    // Then host mode fails closed.
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "SshAgentUnavailableError", reason: "socket-missing", socketPath: link },
    });
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit socket probe failure does not fall through", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given an explicit socket that accepts a connection but never answers, plus a live 1Password agent.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-explicit-dead-"));
  const explicit = join(root, "dead.sock");
  const password = join(root, ".1password", "agent.sock");
  await mkdir(join(root, ".1password"));
  const silent = createServer((socket) => {
    socket.on("data", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    silent.once("error", reject);
    silent.listen(explicit, resolve);
  });
  const live = await listen(password);
  try {
    // When the explicit socket does not answer the identities probe.
    const result = await Effect.runPromise(
      Effect.either(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: {},
          explicitSocket: explicit,
          probeTimeoutMs: 50,
        }),
      ),
    );
    // Then discovery fails closed instead of using 1Password.
    expect(result).toMatchObject({
      _tag: "Left",
      left: { reason: "socket-missing", socketPath: explicit },
    });
  } finally {
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});
