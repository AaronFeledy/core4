import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSshAgentServiceConfig } from "../../src/global-service.ts";

const empty = Buffer.from("000000050c00000000", "hex");
// One Ed25519 public-key blob and an empty comment, framed as SSH_AGENT_IDENTITIES_ANSWER.
const oneKey = Buffer.from(
  `000000400c00000001000000330000000b7373682d6564323535313900000020${"01".repeat(32)}00000000`,
  "hex",
);

for (const scenario of [
  { name: "empty identities answer", reply: empty, exitCode: 0 },
  { name: "nonempty identities answer", reply: oneKey, exitCode: 0 },
  { name: "malformed identities answer", reply: Buffer.from("000000050c00000001", "hex"), exitCode: 1 },
  { name: "disconnect", reply: undefined, exitCode: 1 },
  { name: "cancellation while waiting for a reply", cancel: true },
] as const) {
  test.skipIf(process.platform === "win32")(`declared sidecar readiness: ${scenario.name}`, async () => {
    if (Bun.which("ssh-add") === null)
      throw new Error("OpenSSH ssh-add is required for the POSIX sidecar readiness test.");
    const readiness = createSshAgentServiceConfig().readiness;
    const command = readiness === false ? undefined : readiness?.command;
    if (command === undefined || typeof command === "string") throw new Error("Expected a readiness argv.");
    const root = await mkdtemp(join(tmpdir(), "ssh-reply-"));
    const path = join(root, "agent.sock");
    const sockets = new Set<Socket>();
    const abort = new AbortController();
    const request = Promise.withResolvers<Buffer>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // The client may write the length prefix and the message body separately; answer only a whole frame.
      let received = Buffer.alloc(0);
      socket.on("data", (data) => {
        received = Buffer.concat([received, data]);
        if (received.length < 4 || received.length < 4 + received.readUInt32BE(0)) return;
        socket.removeAllListeners("data");
        request.resolve(received);
        if ("reply" in scenario) {
          if (scenario.reply === undefined) socket.end();
          else socket.end(scenario.reply);
        }
      });
    });
    try {
      server.listen(path);
      await once(server, "listening");
      const child = Bun.spawn([...command], {
        env: { ...process.env, SSH_AUTH_SOCK: path },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        signal: abort.signal,
        timeout: 2_000,
      });
      const frame = await Promise.race([request.promise, child.exited.then(() => undefined)]);
      expect(frame).toEqual(Buffer.from([0, 0, 0, 1, 11]));
      if ("cancel" in scenario) {
        abort.abort();
        await child.exited;
        expect(child.signalCode).toBe("SIGTERM");
      } else {
        expect(await child.exited).toBe(scenario.exitCode);
      }
    } finally {
      abort.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
