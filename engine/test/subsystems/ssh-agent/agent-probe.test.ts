import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshAgentReadinessCommand } from "@lando/sdk/schema";

const unixSocketTest = test.skipIf(process.platform === "win32");

unixSocketTest("the sidecar command accepts an empty agent response and rejects a disconnect", async () => {
  if (Bun.which("ssh-add") === null)
    throw new Error("OpenSSH ssh-add is required for the POSIX sidecar test.");
  const root = await mkdtemp(join(tmpdir(), "ssh-reply-"));
  try {
    for (const [reply, expected] of [
      [Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]), 0],
      [undefined, 1],
    ] as const) {
      const path = join(root, `socket-${expected}`);
      const server = createServer((socket) =>
        socket.once("data", () => (reply === undefined ? socket.end() : socket.end(reply))),
      );
      server.listen(path);
      await once(server, "listening");
      try {
        const child = Bun.spawn(sshAgentReadinessCommand(), {
          env: { ...process.env, SSH_AUTH_SOCK: path },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: 2000,
        });
        expect(await child.exited).toBe(expected);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

unixSocketTest("counts identities from a fake agent server", async () => {
  const { probeSshAgent } = await import("../../../src/subsystems/ssh-agent/agent-probe.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-probe-"));
  const path = join(root, "agent");
  const requests: Buffer[] = [];
  const server = createServer((socket) =>
    socket.once("data", (data) => {
      requests.push(data);
      const frame = Buffer.alloc(25);
      frame.writeUInt32BE(21, 0);
      frame[4] = 12;
      frame.writeUInt32BE(2, 5);
      socket.write(frame.subarray(0, 3));
      socket.end(frame.subarray(3));
    }),
  );
  server.listen(path);
  await once(server, "listening");
  try {
    // When
    const result = await probeSshAgent({ _tag: "unix", path }, { timeoutMs: 500 });
    // Then
    expect(result).toEqual({ identities: 2 });
    expect(requests).toEqual([Buffer.from([0, 0, 0, 1, 11])]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

unixSocketTest("bounds a silent agent and rejects a malformed response", async () => {
  const { probeSshAgent } = await import("../../../src/subsystems/ssh-agent/agent-probe.ts");
  for (const response of [undefined, Buffer.from([0, 0, 0, 1, 5])]) {
    // Given
    const root = await mkdtemp(join(tmpdir(), "agent-probe-fail-"));
    const path = join(root, "agent");
    const server = createServer((socket) =>
      socket.once("data", () => {
        if (response !== undefined) socket.end(response);
      }),
    );
    server.listen(path);
    await once(server, "listening");
    try {
      // When / Then
      await expect(probeSshAgent({ _tag: "unix", path }, { timeoutMs: 30 })).rejects.toMatchObject({
        _tag: "SshAgentTransportError",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
