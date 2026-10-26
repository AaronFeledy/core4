import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";
import {
  makeHttpDockerApiClient,
  makeNamedPipeDockerApiClient,
  makeUnixDockerApiClient,
} from "../src/docker/api-client.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";
import { connectSocket, socketHttpConnection } from "../src/transport.ts";

const ctx = { providerId: "test", remediation: "Start the test engine." };

test.each(["podman", "docker-unix", "docker-http", "docker-npipe"] as const)(
  "%s destroys a stalled DELETE connection when its request effect is interrupted",
  async (provider) => {
    // Given: a real connection that accepts DELETE but never sends response headers.
    const root = await mkdtemp(join(tmpdir(), "lando-delete-abort-"));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lando-delete-abort-${crypto.randomUUID()}`
        : join(root, "engine.sock");
    const sockets = new Set<Socket>();
    const received = Promise.withResolvers<string>();
    const closed = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    // A watchdog only: synchronization uses request arrival and socket closure, not sleeps.
    const timer = setTimeout(
      () => deadline.reject(new TypeError("DELETE connection survived interruption")),
      1000,
    );
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
      socket.once("data", (data) => received.resolve(data.toString()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("Expected TCP address");
    const unixServer = createServer((socket) => server.emit("connection", socket));
    await new Promise<void>((resolve) => unixServer.listen(endpoint, resolve));
    const client = (() => {
      switch (provider) {
        case "podman":
          return makePodmanApiClient(endpoint, ctx);
        case "docker-unix":
          return makeUnixDockerApiClient(endpoint, ctx);
        case "docker-http":
          return makeHttpDockerApiClient(`http://127.0.0.1:${address.port}`, ctx);
        case "docker-npipe":
          return makeNamedPipeDockerApiClient("\\\\.\\pipe\\test", ctx, undefined, async () => {
            const socket = createConnection({ path: endpoint });
            await connectSocket(socket);
            return socketHttpConnection(socket);
          });
        default: {
          const exhaustive: never = provider;
          return exhaustive;
        }
      }
    })();
    if (client.request === undefined) throw new TypeError("Expected request API");
    const fiber = Effect.runFork(
      client.request({ method: "DELETE", path: "/containers/test?force=true&v=true" }),
    );
    try {
      expect(await Promise.race([received.promise, deadline.promise])).toMatch(/^DELETE /);

      // When: interrupt the same request effect that the finalizer deadline must cancel.
      const exit = await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))),
        deadline.promise,
      ]);

      // Then: interruption reaches the actual transport, without a response unblocking it.
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      await Promise.race([closed.promise, deadline.promise]);
      expect(sockets.size).toBe(0);
    } finally {
      clearTimeout(timer);
      // Force transport completion even on the red path; never leave a curl/socket hanging.
      for (const socket of sockets) socket.destroy();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => unixServer.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
  3000,
);
