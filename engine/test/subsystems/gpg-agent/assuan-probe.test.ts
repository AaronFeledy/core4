import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRestrictedGpgAgent } from "../../../src/subsystems/gpg-agent/assuan-probe.ts";

const listen = (server: Server, path: string) => new Promise<void>((resolve) => server.listen(path, resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

const fakeAgent = (reply: string | undefined, received: string[]) =>
  createServer((socket) => {
    socket.write("OK Pleased to meet you, process 1234\n");
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk.toString());
      if (reply !== undefined) socket.write(reply);
    });
  });

test.each([
  ["OK\n", "restricted"],
  ["ERR 67108987 False <GPG Agent>\n", "unrestricted"],
] as const)("reads GETINFO restricted reply %j as %s", async (reply, expected) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "assuan-probe-"));
  const path = join(root, "S.gpg-agent.extra");
  const received: string[] = [];
  const server = fakeAgent(reply, received);
  await listen(server, path);
  try {
    // When
    const result = await probeRestrictedGpgAgent(path, { timeoutMs: 2_000 });
    // Then
    expect(result).toBe(expected);
    expect(received).toEqual(["GETINFO restricted\n"]);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("skips status and comment lines before the answer", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "assuan-probe-"));
  const path = join(root, "S.gpg-agent.extra");
  const server = createServer((socket) => {
    socket.write("# greeting comment\nOK Pleased to meet you\n");
    socket.once("data", () => socket.write("S PROGRESS x\n# note\nOK\n"));
  });
  await listen(server, path);
  try {
    // When
    const result = await probeRestrictedGpgAgent(path, { timeoutMs: 2_000 });
    // Then
    expect(result).toBe("restricted");
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds a silent agent and rejects a refused connection", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "assuan-probe-"));
  const silentPath = join(root, "silent.sock");
  const silent = createServer(() => undefined);
  await listen(silent, silentPath);
  try {
    // When
    const started = Date.now();
    // Then
    await Promise.all([
      expect(probeRestrictedGpgAgent(silentPath, { timeoutMs: 100 })).rejects.toThrow(/timed out/i),
      expect(probeRestrictedGpgAgent(join(root, "absent.sock"), { timeoutMs: 100 })).rejects.toThrow(
        /refused/i,
      ),
    ]);
    expect(Date.now() - started).toBeLessThan(1_500);
  } finally {
    await close(silent);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an agent whose greeting is an error", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "assuan-probe-"));
  const path = join(root, "S.gpg-agent.extra");
  const server = createServer((socket) => {
    socket.write("ERR 1 Refused\n");
  });
  await listen(server, path);
  try {
    // When / Then
    await expect(probeRestrictedGpgAgent(path, { timeoutMs: 1_000 })).rejects.toThrow(/greet/i);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
