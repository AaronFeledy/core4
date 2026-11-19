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

const ctx = { providerId: "test", remediation: "Start the test engine.", env: {} };

const providers = ["podman", "docker-unix", "docker-http", "docker-npipe"] as const;
type Provider = (typeof providers)[number];

/** Pin Docker's prefix so wait arms without a settle probe racing the stall fixture. */
const dockerOptions = { env: { DOCKER_API_VERSION: "1.43" } } as const;

const waitPath = (provider: Provider): `/${string}` =>
  provider === "podman" ? "/libpod/containers/test/wait" : "/containers/test/wait";

const inspectPath = (provider: Provider): `/${string}` =>
  provider === "podman" ? "/libpod/containers/test/json" : "/containers/test/json";

const isWaitRequestLine = (line: string): boolean => {
  const path = line.split(" ")[1] ?? "";
  return /\/containers\/[^/]+\/wait(?:\?|$)/u.test(path);
};

const makeClient = (provider: Provider, endpoint: string, tcpPort: number) => {
  switch (provider) {
    case "podman":
      return makePodmanApiClient(endpoint, ctx);
    case "docker-unix":
      return makeUnixDockerApiClient(endpoint, ctx, dockerOptions);
    case "docker-http":
      return makeHttpDockerApiClient(`http://127.0.0.1:${tcpPort}`, ctx, dockerOptions);
    case "docker-npipe":
      return makeNamedPipeDockerApiClient("\\\\.\\pipe\\test", ctx, dockerOptions, async () => {
        const socket = createConnection({ path: endpoint });
        await connectSocket(socket);
        return socketHttpConnection(socket);
      });
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
};

type StallPhase = "before-headers" | "after-headers";

const runStalledWaitCase = async (
  provider: Provider,
  phase: StallPhase,
  body: (input: {
    readonly request: NonNullable<ReturnType<typeof makeClient>["request"]>;
    readonly waitReceived: Promise<string>;
    readonly waitClosed: Promise<void>;
    readonly waitHeadersSent: Promise<void>;
    readonly sockets: Set<Socket>;
    readonly deadline: Promise<never>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), `lando-wait-abort-${provider}-${phase}-`));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\lando-wait-abort-${provider}-${crypto.randomUUID()}`
      : join(root, "engine.sock");
  const sockets = new Set<Socket>();
  const waitReceived = Promise.withResolvers<string>();
  const waitClosed = Promise.withResolvers<void>();
  const waitHeadersSent = Promise.withResolvers<void>();
  const deadline = Promise.withResolvers<never>();
  // Watchdog only: synchronization uses request arrival, headers, and socket closure.
  const timer = setTimeout(
    () => deadline.reject(new TypeError(`${provider} ${phase} wait connection survived interruption`)),
    1500,
  );
  let waitSocket: Socket | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (socket === waitSocket) waitClosed.resolve();
    });
    socket.once("data", (data) => {
      const text = data.toString();
      const requestLine = text.split("\r\n")[0] ?? "";
      if (isWaitRequestLine(requestLine)) {
        waitSocket = socket;
        waitReceived.resolve(text);
        if (phase === "after-headers") {
          // Headers only: body never arrives so the client stays blocked reading Content-Length.
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 32\r\nConnection: close\r\n\r\n",
          );
          waitHeadersSent.resolve();
        }
        return;
      }
      // Concurrent short requests must complete while wait is held open.
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP address");
  const unixServer = createServer((socket) => server.emit("connection", socket));
  await new Promise<void>((resolve) => unixServer.listen(endpoint, resolve));
  const client = makeClient(provider, endpoint, address.port);
  if (client.request === undefined) throw new TypeError("Expected request API");
  try {
    await body({
      request: client.request,
      waitReceived: waitReceived.promise,
      waitClosed: waitClosed.promise,
      waitHeadersSent: waitHeadersSent.promise,
      sockets,
      deadline: deadline.promise,
    });
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => unixServer.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
};

test.each([...providers])(
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
    const client = makeClient(provider, endpoint, address.port);
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

test.each([...providers])(
  "%s destroys a stalled POST wait before headers when its request effect is interrupted",
  async (provider) => {
    await runStalledWaitCase(
      provider,
      "before-headers",
      async ({ request, waitReceived, waitClosed, sockets, deadline }) => {
        // Given: wait accepted, no response headers.
        const fiber = Effect.runFork(request({ method: "POST", path: waitPath(provider) }));
        try {
          expect(await Promise.race([waitReceived, deadline])).toMatch(/^POST /);

          // When: interrupt the wait effect while headers are still pending.
          const exit = await Promise.race([
            Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))),
            deadline,
          ]);

          // Then: interruption closes the wait socket without a response unblocking it.
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          await Promise.race([waitClosed, deadline]);
          expect(sockets.size).toBe(0);
        } finally {
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
      },
    );
  },
  3000,
);

test.each([...providers])(
  "%s destroys a stalled POST wait after headers when its request effect is interrupted",
  async (provider) => {
    await runStalledWaitCase(
      provider,
      "after-headers",
      async ({ request, waitReceived, waitHeadersSent, waitClosed, sockets, deadline }) => {
        // Given: wait headers delivered, body never arrives.
        const fiber = Effect.runFork(request({ method: "POST", path: waitPath(provider) }));
        try {
          expect(await Promise.race([waitReceived, deadline])).toMatch(/^POST /);
          await Promise.race([waitHeadersSent, deadline]);

          // When: interrupt while blocked on the incomplete wait body.
          const exit = await Promise.race([
            Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))),
            deadline,
          ]);

          // Then: cancellation still closes the wait socket.
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          await Promise.race([waitClosed, deadline]);
          expect(sockets.size).toBe(0);
        } finally {
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
      },
    );
  },
  3000,
);

test.each([...providers])(
  "%s lets a concurrent inspect proceed while POST wait is held, and wait cancellation closes the socket",
  async (provider) => {
    await runStalledWaitCase(
      provider,
      "before-headers",
      async ({ request, waitReceived, waitClosed, sockets, deadline }) => {
        // Given: a long-lived wait holding its connection open.
        const waitFiber = Effect.runFork(request({ method: "POST", path: waitPath(provider) }));
        try {
          expect(await Promise.race([waitReceived, deadline])).toMatch(/^POST /);

          // When: another request runs while wait is still outstanding.
          const inspect = await Promise.race([
            Effect.runPromise(request({ method: "GET", path: inspectPath(provider) })),
            deadline,
          ]);
          expect(inspect).toMatchObject({ status: 200, body: "{}" });

          // And: interrupting wait closes only that wait connection.
          const exit = await Promise.race([
            Effect.runPromise(Fiber.interrupt(waitFiber).pipe(Effect.andThen(Fiber.await(waitFiber)))),
            deadline,
          ]);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          await Promise.race([waitClosed, deadline]);
          expect(sockets.size).toBe(0);
        } finally {
          await Effect.runPromise(Fiber.interrupt(waitFiber));
        }
      },
    );
  },
  3000,
);
