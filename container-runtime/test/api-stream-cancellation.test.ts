import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import {
  makeHttpDockerApiClient,
  makeNamedPipeDockerApiClient,
  makeUnixDockerApiClient,
} from "../src/docker/api-client.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";
import { connectSocket, socketHttpConnection } from "../src/transport.ts";

const ctx = { providerId: "test", remediation: "Start the test engine.", env: {} };

const cases = (["podman", "docker-unix", "docker-http", "docker-npipe"] as const).flatMap((provider) =>
  (["interrupt", "eof", "error"] as const).map((mode) => [provider, mode] as const),
);

test.each(cases)(
  "%s closes its actual connection on %s",
  async (provider, mode) => {
    // Given: a real HTTP connection, either idle after one record or a finite response.
    const root = await mkdtemp(join(tmpdir(), "lando-idle-api-"));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lando-idle-api-${crypto.randomUUID()}`
        : join(root, "engine.sock");
    const sockets = new Set<Socket>();
    const closed = Promise.withResolvers<void>();
    const consumed = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new TypeError("Idle cancellation did not complete")), 500);
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
      socket.once("data", () => {
        switch (mode) {
          case "interrupt":
            socket.write("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nfirst\n");
            break;
          case "eof":
            socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nfirst\nlast\n");
            break;
          case "error":
            socket.end("HTTP/1.1 500 Failed\r\nContent-Length: 4\r\n\r\noops");
            break;
        }
      });
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
      }
    })();
    if (client.stream === undefined) throw new TypeError("Expected stream API");
    const fiber = Effect.runFork(
      client.stream({ method: "GET", path: "/containers/test/logs?follow=true" }).pipe(
        Stream.tap(() => Effect.sync(() => consumed.resolve())),
        Stream.runCollect,
      ),
    );
    try {
      // When: interrupt the idle read directly, or let the finite response finish.
      switch (mode) {
        case "interrupt": {
          await Promise.race([consumed.promise, deadline.promise]);
          const interrupted = Effect.runPromise(
            Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
          );
          const exit = await Promise.race([interrupted, deadline.promise]);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          break;
        }
        case "eof": {
          const chunks = await Promise.race([Effect.runPromise(Fiber.join(fiber)), deadline.promise]);
          expect(Buffer.concat(chunks).toString()).toBe("first\nlast\n");
          break;
        }
        case "error": {
          const exit = await Promise.race([Effect.runPromise(Fiber.await(fiber)), deadline.promise]);
          if (!Exit.isFailure(exit)) throw new TypeError("Expected HTTP failure");
          const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
          expect(error).toBeInstanceOf(ProviderUnavailableError);
          expect(error.details).toMatchObject({ status: 500, body: "oops" });
          break;
        }
      }
      // Then: the server observes connection closure, with no extra bytes needed for interruption.
      await Promise.race([closed.promise, deadline.promise]);
      expect(sockets.size).toBe(0);
    } finally {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => unixServer.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
  2000,
);
