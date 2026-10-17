import { expect, spyOn, test } from "bun:test";
import { lstatSync } from "node:fs";
import { chown, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

const rootOwnedSystemSocket = (): string | undefined => {
  const self = process.getuid?.();
  if (process.platform === "win32" || self === undefined || self === 0) return undefined;
  for (const path of ["/run/dbus/system_bus_socket", "/run/host-services/ssh-auth.sock"]) {
    try {
      const stats = lstatSync(path);
      if (stats.isSocket() && stats.uid === 0) return path;
    } catch {}
  }
  return undefined;
};

const explicitRootOwnedTarget = rootOwnedSystemSocket();

test("prefers explicit socket, then SSH_AUTH_SOCK, then 1Password path per platform", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  for (const platform of ["linux", "wsl", "darwin"] as const) {
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
        platform === "darwin"
          ? "/home/test/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
          : "/home/test/.1password/agent.sock",
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
    Effect.result(
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
    _tag: "Failure",
    failure: { reason: "host-agent-not-found" },
  });
});

test("fails host-agent-not-found with remediation", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given / When
  const result = await Effect.runPromise(
    Effect.result(
      discoverHostSshAgent({ platform: "linux", home: "/home/test", env: {}, exists: async () => false }),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
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
    Effect.result(
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
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "socket-missing", socketPath: "/missing" },
  });
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

test("explicit live symlink is accepted and relayed by authored path", async () => {
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
      discoverHostSshAgent({
        platform: "linux",
        home: root,
        env: { SSH_AUTH_SOCK: live },
        explicitSocket: link,
      }),
    );
    // Then the authored symlink path is selected, not the resolved socket.
    expect(result.upstream).toEqual({ _tag: "unix", path: link, source: "explicit" });
    expect(link).not.toBe(live);
    expect(result.identities).toBe(0);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit socket owned by another user is socket-owner-mismatch", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given an explicit socket whose target is owned by another uid.
  const foreignUid = (process.getuid?.() ?? 0) + 12_345;
  // When discovery inspects that socket.
  const result = await Effect.runPromise(
    Effect.result(
      discoverHostSshAgent({
        platform: "linux",
        home: "/home/test",
        env: {},
        explicitSocket: "/foreign.sock",
        inspect: () => Effect.succeed({ kind: "socket", uid: foreignUid }),
        probe: alive,
      }),
    ),
  );
  // Then host mode names the target owner and does not fall through.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "SshAgentUnavailableError",
      reason: "socket-owner-mismatch",
      socketPath: "/foreign.sock",
    },
  });
  if (result._tag !== "Failure") throw new Error("expected failure");
  expect(result.failure.message).toContain(`uid ${foreignUid}`);
});

test("explicit symlink whose target is owned by another user is socket-owner-mismatch", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a link we own that points at a socket owned by someone else.
  const self = process.getuid?.() ?? 0;
  const foreignUid = self + 12_345;
  // When discovery inspects that explicit symlink.
  const result = await Effect.runPromise(
    Effect.result(
      discoverHostSshAgent({
        platform: "linux",
        home: "/home/test",
        env: {},
        explicitSocket: "/link.sock",
        inspect: () =>
          Effect.succeed({ kind: "symlink", uid: self, targetUid: foreignUid, targetKind: "socket" }),
        probe: alive,
      }),
    ),
  );
  // Then the target owner is named even though the link uid matches.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "socket-owner-mismatch", socketPath: "/link.sock" },
  });
  if (result._tag !== "Failure") throw new Error("expected failure");
  expect(result.failure.message).toBe(
    `The configured SSH agent socket is owned by uid ${foreignUid}, not the current user.`,
  );
});

test("explicit symlink owned by another user is socket-owner-mismatch", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a foreign-owned link that points at a socket we own.
  const self = process.getuid?.() ?? 0;
  const foreignUid = self + 12_345;
  // When discovery inspects that explicit symlink.
  const result = await Effect.runPromise(
    Effect.result(
      discoverHostSshAgent({
        platform: "linux",
        home: "/home/test",
        env: {},
        explicitSocket: "/link.sock",
        inspect: () =>
          Effect.succeed({ kind: "symlink", uid: foreignUid, targetUid: self, targetKind: "socket" }),
        probe: alive,
      }),
    ),
  );
  // Then the link owner is named even though the target uid matches.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "socket-owner-mismatch", socketPath: "/link.sock" },
  });
  if (result._tag !== "Failure") throw new Error("expected failure");
  expect(result.failure.message).toContain(`uid ${foreignUid}`);
});

test.skipIf(explicitRootOwnedTarget === undefined)(
  "explicit symlink to a root-owned socket is socket-owner-mismatch",
  async () => {
    const { discoverHostSshAgent } = await import(
      "../../../src/subsystems/ssh-agent/host-agent-discovery.ts"
    );
    // Given a link we own pointing at a uid-0 system socket, with no inspect override.
    const target = explicitRootOwnedTarget as string;
    const self = process.getuid?.() ?? 0;
    const root = await mkdtemp(join(tmpdir(), "ssh-agent-root-owned-"));
    const link = join(root, "link.sock");
    await symlink(target, link);
    try {
      expect((await lstat(link)).uid).toBe(self);
      expect((await lstat(await realpath(link))).uid).toBe(0);
      // When the explicit socket is that symlink.
      const result = await Effect.runPromise(
        Effect.result(
          discoverHostSshAgent({
            platform: "linux",
            home: root,
            env: {},
            explicitSocket: link,
          }),
        ),
      );
      // Then the target owner is named; reading the target uid from the link would pass.
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "socket-owner-mismatch", socketPath: link },
      });
      if (result._tag !== "Failure") throw new Error("expected failure");
      expect(result.failure.message).toContain("uid 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("env SSH_AUTH_SOCK owned by another user is still selected", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given SSH_AUTH_SOCK pointing at a live socket owned by another uid.
  const foreignUid = (process.getuid?.() ?? 0) + 12_345;
  // When auto-discovery inspects that env socket.
  const result = await Effect.runPromise(
    discoverHostSshAgent({
      platform: "linux",
      home: "/home/test",
      env: { SSH_AUTH_SOCK: "/run/host-services/ssh-auth.sock" },
      inspect: () => Effect.succeed({ kind: "socket", uid: foreignUid }),
      probe: alive,
    }),
  );
  // Then env wins; owner checks apply only to sshAgent.socket.
  expect(result.upstream).toEqual({
    _tag: "unix",
    path: "/run/host-services/ssh-auth.sock",
    source: "env",
  });
});

test("auto-discovery probes a plain-file SSH_AUTH_SOCK", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given Windows AF_UNIX SSH_AUTH_SOCK reported as a regular file, not a socket.
  const probed: string[] = [];
  // When auto-discovery inspects that env path as kind other.
  const result = await Effect.runPromise(
    discoverHostSshAgent({
      platform: "win32",
      home: "C:\\Users\\test",
      env: { SSH_AUTH_SOCK: "C:\\Users\\test\\agent.sock" },
      inspect: () => Effect.succeed({ kind: "other" }),
      probe: (upstream) => {
        probed.push(upstream.path);
        return Effect.succeed({ identities: 1 });
      },
    }),
  );
  // Then the env path is probed and selected instead of skipped as not a socket.
  expect(probed).toEqual(["C:\\Users\\test\\agent.sock"]);
  expect(result.upstream).toEqual({
    _tag: "unix",
    path: "C:\\Users\\test\\agent.sock",
    source: "env",
  });
});

test("win32 non-pipe SSH_AUTH_SOCK is selected even with a foreign uid", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a unix SSH_AUTH_SOCK on win32 whose inspect reports another owner.
  const foreignUid = (process.getuid?.() ?? 0) + 12_345;
  // When auto-discovery runs.
  const result = await Effect.runPromise(
    discoverHostSshAgent({
      platform: "win32",
      home: "C:\\Users\\test",
      env: { SSH_AUTH_SOCK: "C:\\Users\\test\\agent.sock" },
      inspect: () => Effect.succeed({ kind: "socket", uid: foreignUid }),
      probe: alive,
    }),
  );
  // Then the env unix socket is used instead of skipping to the named pipe.
  expect(result.upstream).toEqual({
    _tag: "unix",
    path: "C:\\Users\\test\\agent.sock",
    source: "env",
  });
});

test("a dangling 1Password socket is not env-socket-dangling", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a dangling 1Password agent path and no SSH_AUTH_SOCK.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-password-dangling-"));
  await mkdir(join(root, ".1password"));
  await symlink(join(root, "absent"), join(root, ".1password", "agent.sock"));
  try {
    // When discovery finds no env socket and the 1Password path does not resolve.
    const result = await Effect.runPromise(
      Effect.result(discoverHostSshAgent({ platform: "linux", home: root, env: {} })),
    );
    // Then that dangling candidate is not reported as a stale SSH_AUTH_SOCK.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "host-agent-not-found" },
    });
    if (result._tag !== "Failure") throw new Error("expected failure");
    expect(result.failure.reason).not.toBe("env-socket-dangling");
    expect(result.failure.socketPath).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit dangling symlink is socket-missing, not socket-not-socket", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given an explicit symlink whose target is gone.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-explicit-dangling-"));
  const link = join(root, "link.sock");
  await symlink(join(root, "absent"), link);
  try {
    // When discovery inspects that explicit path.
    const result = await Effect.runPromise(
      Effect.result(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: { SSH_AUTH_SOCK: join(root, "env.sock") },
          explicitSocket: link,
        }),
      ),
    );
    // Then the missing link is socket-missing, not a non-socket.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "socket-missing", socketPath: link },
    });
    if (result._tag !== "Failure") throw new Error("expected failure");
    expect(result.failure.reason).not.toBe("socket-not-socket");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "env SSH_AUTH_SOCK owned by another user is selected without an inspector",
  async () => {
    const { discoverHostSshAgent } = await import(
      "../../../src/subsystems/ssh-agent/host-agent-discovery.ts"
    );
    // Given a live env socket whose owner does not match getuid, with no inspect/exists override.
    const root = await mkdtemp(join(tmpdir(), "ssh-agent-foreign-env-"));
    const socket = join(root, "agent.sock");
    const agent = await listen(socket);
    const self = process.getuid?.() ?? 0;
    let restoreGetuid: (() => void) | undefined;
    try {
      if (self === 0) {
        await chown(socket, 1, 1);
        expect((await lstat(socket)).uid).toBe(1);
      } else {
        const spy = spyOn(process, "getuid").mockImplementation(() => self + 1);
        restoreGetuid = () => spy.mockRestore();
        expect((await lstat(socket)).uid).toBe(self);
        expect(process.getuid?.()).toBe(self + 1);
      }
      // When auto-discovery uses real lstat.
      const result = await Effect.runPromise(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: { SSH_AUTH_SOCK: socket },
        }),
      );
      // Then the foreign-owned env socket is still selected.
      expect(result.upstream).toEqual({ _tag: "unix", path: socket, source: "env" });
    } finally {
      restoreGetuid?.();
      await agent.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("explicit symlink to a non-socket is socket-not-socket", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given an explicit symlink whose target is a regular file.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-not-socket-"));
  const file = join(root, "plain");
  const link = join(root, "link.sock");
  await writeFile(file, "not-a-socket");
  await symlink(file, link);
  try {
    // When discovery inspects that explicit path.
    const result = await Effect.runPromise(
      Effect.result(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: { SSH_AUTH_SOCK: file },
          explicitSocket: link,
        }),
      ),
    );
    // Then host mode fails closed as not a socket.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SshAgentUnavailableError", reason: "socket-not-socket", socketPath: link },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dangling SSH_AUTH_SOCK is env-socket-dangling when no other agent is found", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given SSH_AUTH_SOCK as a dangling symlink and no other host agent.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-dangling-"));
  const dangling = join(root, "gone.sock");
  await symlink(join(root, "absent"), dangling);
  try {
    // When discovery finds no other candidate.
    const result = await Effect.runPromise(
      Effect.result(
        discoverHostSshAgent({
          platform: "linux",
          home: root,
          env: { SSH_AUTH_SOCK: dangling },
        }),
      ),
    );
    // Then the dangling env socket is the reported failure.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SshAgentUnavailableError",
        reason: "env-socket-dangling",
        socketPath: dangling,
      },
    });
    if (result._tag !== "Failure") throw new Error("expected failure");
    expect(result.failure.message).toContain("no longer exists");
    expect(result.failure.remediation).toContain("Open a new terminal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dangling SSH_AUTH_SOCK is remembered when a live 1Password agent is selected", async () => {
  const { discoverHostSshAgent } = await import("../../../src/subsystems/ssh-agent/host-agent-discovery.ts");
  // Given a dangling env socket and a live 1Password agent.
  const root = await mkdtemp(join(tmpdir(), "ssh-agent-dangling-fallback-"));
  const dangling = join(root, "gone.sock");
  const password = join(root, ".1password", "agent.sock");
  await mkdir(join(root, ".1password"));
  await symlink(join(root, "absent"), dangling);
  const agent = await listen(password);
  try {
    // When discovery falls through past SSH_AUTH_SOCK.
    const result = await Effect.runPromise(
      discoverHostSshAgent({
        platform: "linux",
        home: root,
        env: { SSH_AUTH_SOCK: dangling },
      }),
    );
    // Then 1Password is selected and the dangling env socket is retained.
    expect(result.upstream).toMatchObject({ source: "1password", path: password, _tag: "unix" });
    expect(result.danglingEnvSocket).toBe(dangling);
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
      Effect.result(
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
      _tag: "Failure",
      failure: { reason: "socket-missing", socketPath: explicit },
    });
  } finally {
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});
