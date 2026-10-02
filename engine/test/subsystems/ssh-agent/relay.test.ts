import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("named-pipe upstream dispatches through net.connect path options", async () => {
  // Given
  const { connectAgentUpstream } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  const path = String.raw`\\.\pipe\openssh-ssh-agent`;
  const calls: unknown[] = [];
  const socket = new Socket();
  // When
  const result = connectAgentUpstream({ _tag: "named-pipe", path }, (options) => {
    calls.push(options);
    return socket;
  });
  // Then
  expect(calls).toEqual([{ path }]);
  expect(result).toBe(socket);
  socket.destroy();
});

test("relays bytes both ways between a unix client and a unix upstream", async () => {
  // Given
  const { createAgentRelay } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-relay-"));
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(join(root, "upstream"));
  await once(upstream, "listening");
  const relay = await createAgentRelay({
    upstream: { _tag: "unix", path: join(root, "upstream") },
    listen: { _tag: "unix", path: join(root, "agent.sock"), mode: 0o666 },
  });
  const client = connect({ path: join(root, "agent.sock") });
  try {
    await once(client, "connect");
    // When
    const received = once(client, "data");
    client.write(Buffer.from([0, 255, 11, 0, 128]));
    // Then
    expect((await received)[0]).toEqual(Buffer.from([0, 255, 11, 0, 128]));
    expect((await stat(join(root, "agent.sock"))).mode & 0o777).toBe(0o666);
  } finally {
    client.destroy();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback-tcp listener rejects a wrong token and accepts a fragmented right one", async () => {
  // Given
  const { createAgentRelay, makeAgentRelayToken } = await import(
    "../../../src/subsystems/ssh-agent/relay.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "agent-token-"));
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(join(root, "upstream"));
  await once(upstream, "listening");
  const token = makeAgentRelayToken();
  const relay = await createAgentRelay({
    upstream: { _tag: "unix", path: join(root, "upstream") },
    listen: { _tag: "loopback-tcp", token },
  });
  if (relay.address._tag !== "loopback-tcp") throw new Error("Expected TCP");
  const bad = connect({ port: relay.address.port, host: "127.0.0.1" });
  const good = connect({ port: relay.address.port, host: "127.0.0.1" });
  try {
    // When
    const rejected = once(bad, "close");
    bad.end("x".repeat(43));
    await rejected;
    const received = once(good, "data");
    good.write(token.slice(0, 20));
    good.write(`${token.slice(20)}hello`);
    // Then
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await received)[0].toString()).toBe("hello");
  } finally {
    bad.destroy();
    good.destroy();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("close terminates active connections and unlinks the socket", async () => {
  // Given
  const { createAgentRelay } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-close-"));
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(join(root, "upstream"));
  await once(upstream, "listening");
  const path = join(root, "agent.sock");
  const relay = await createAgentRelay({
    upstream: { _tag: "unix", path: join(root, "upstream") },
    listen: { _tag: "unix", path, mode: 0o666 },
  });
  const client = connect({ path });
  try {
    await once(client, "connect");
    const data = once(client, "data");
    client.write("ready");
    await data;
    const closed = once(client, "close");
    // When
    await relay.close();
    await closed;
    // Then
    expect(relay.activeConnections()).toBe(0);
    expect(await stat(path).catch(() => undefined)).toBeUndefined();
  } finally {
    client.destroy();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to unlink a regular file at the listener path", async () => {
  // Given
  const { createAgentRelay } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-file-"));
  const path = join(root, "agent.sock");
  await writeFile(path, "keep");
  try {
    // When / Then
    await expect(
      createAgentRelay({ upstream: { _tag: "unix", path }, listen: { _tag: "unix", path, mode: 0o666 } }),
    ).rejects.toMatchObject({ _tag: "SshAgentTransportError" });
    expect(await Bun.file(path).text()).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS long listener paths use a short stable fallback", async () => {
  const { agentRelayListenPath } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-path-"));
  const path = join(root, "long".repeat(30), "agent.sock");
  try {
    // When
    const shortened = agentRelayListenPath(path, "darwin");
    // Then
    expect(Buffer.byteLength(shortened)).toBeLessThan(100);
    expect(shortened).toBe(agentRelayListenPath(path, "darwin"));
    expect(agentRelayListenPath(path, "linux")).toBe(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaces a stale unix socket without displacing a live listener", async () => {
  const { createAgentRelay } = await import("../../../src/subsystems/ssh-agent/relay.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-stale-"));
  const path = join(root, "agent.sock");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready\\n"))',
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  child.kill("SIGKILL");
  await child.exited;
  const options = {
    upstream: { _tag: "unix" as const, path: join(root, "upstream") },
    listen: { _tag: "unix" as const, path, mode: 0o666 },
  };
  const relay = await createAgentRelay(options);
  try {
    // When / Then
    await expect(createAgentRelay(options)).rejects.toMatchObject({ _tag: "SshAgentTransportError" });
    expect((await stat(path)).isSocket()).toBe(true);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
