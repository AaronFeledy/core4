import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Effect, Exit } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { RequestPolicy, layerWith } from "../src/live.ts";

test.each([
  { address: "pinned.invalid", origin: "http://pinned.invalid" },
  { address: "[::1]", origin: "http://pinned.invalid" },
  { address: "127.0.0.1", origin: "http://other.invalid" },
  { address: "127.0.0.1", origin: "http://pinned.invalid/" },
  { address: "127.0.0.1", origin: "http://pinned.invalid:80" },
  { address: "127.0.0.1", origin: "http://pinned.invalid", host: "other.invalid" },
  { address: "127.0.0.1", origin: "http://pinned.invalid", offline: true },
])("rejects invalid pins, conflicting authorities, or offline requests before egress: %j", async (input) => {
  // Given transports that record any connection attempt.
  const calls: string[] = [];
  const policy = {
    connectionTarget: input,
    ...(input.offline === undefined ? {} : { offline: input.offline }),
  };
  // When the service receives a forbidden or malformed pinned request.
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* client.get("http://pinned.invalid/", {
        headers: input.host === undefined ? {} : { host: input.host },
      });
    }).pipe(
      Effect.provide(
        layerWith({
          env: {},
          fetch: Object.assign(
            async () => {
              calls.push("fetch");
              return new Response();
            },
            { preconnect: () => {} },
          ),
          direct: async () => {
            calls.push("direct");
            return new Response();
          },
        }),
      ),
      Effect.provideService(RequestPolicy, policy),
    ),
  );
  // Then neither transport is opened.
  expect(Exit.isFailure(result)).toBe(true);
  expect(calls).toEqual([]);
});

test.each(["scope", "cancel"] as const)("releases a pinned socket on %s", async (mode) => {
  // Given a pinned endpoint which never completes its response.
  const received = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.on("close", () => closed.resolve());
    response.writeHead(200);
    response.write("first chunk");
    received.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  const origin = `http://pinned.invalid:${address.port}`;
  try {
    // When the caller releases the scope or interrupts a body read.
    const controller = new AbortController();
    const result = Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* HttpClient.withScope(client).get(`${origin}/`);
        return mode === "cancel" ? yield* response.text : response.status;
      }).pipe(
        Effect.scoped,
        Effect.provide(layerWith({ env: {} })),
        Effect.provideService(RequestPolicy, { connectionTarget: { address: "127.0.0.1", origin } }),
      ),
      { signal: controller.signal },
    );
    await received.promise;
    if (mode === "cancel") controller.abort();
    const exit = await result;
    await closed.promise;
    // Then the actual server socket closes, with cancellation distinguished from success.
    expect(Exit.isSuccess(exit)).toBe(mode === "scope");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
