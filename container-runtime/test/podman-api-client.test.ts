import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Stream } from "effect";

import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import { LIBPOD_API_PREFIX, isNamedPipeEndpoint, makePodmanApiClient } from "../src/podman/api-client.ts";

const ctx = { providerId: "custom-podman", remediation: "Start the custom Podman machine." } as const;

interface SocketFixture {
  readonly endpoint: string;
  readonly requests: readonly string[];
}

const withSocketServer = async <A>(
  responseFor: (requestLine: string) => string,
  action: (fixture: SocketFixture) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "container-runtime-podman-"));
  const endpoint = join(root, "podman.sock");
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const requestLine = data.toString().split("\r\n")[0] ?? "";
      requests.push(requestLine);
      socket.end(responseFor(requestLine));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    return await action({ endpoint, requests });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    );
    await rm(root, { recursive: true, force: true });
  }
};

const httpResponse = (body: string, status = 200): string =>
  `HTTP/1.1 ${status} Test\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

describe("Podman API client", () => {
  test("identifies and normalizes named-pipe endpoints", () => {
    // Given / When / Then
    expect(isNamedPipeEndpoint("npipe://./pipe/podman-machine-default")).toBe(true);
    expect(isNamedPipeEndpoint("\\\\.\\pipe\\podman-machine-default")).toBe(true);
    expect(isNamedPipeEndpoint("/run/user/1000/podman.sock")).toBe(false);
  });

  test("reads parsed info from a Unix socket at the versioned libpod path", async () => {
    await withSocketServer(
      () => httpResponse('{"host":{"arch":"x64"}}'),
      async ({ endpoint, requests }) => {
        // Given
        const client = makePodmanApiClient(endpoint, ctx);

        // When
        const info = await Effect.runPromise(client.info);

        // Then
        expect(info).toEqual({ host: { arch: "x64" } });
        expect(requests).toEqual(["GET /v6.0.0/libpod/info HTTP/1.1"]);
      },
    );
  });

  test("uses the sole API prefix for ordinary requests", async () => {
    await withSocketServer(
      () => httpResponse("{}"),
      async ({ endpoint, requests }) => {
        // Given
        const request = makePodmanApiClient(endpoint, ctx).request;
        if (request === undefined) throw new Error("Podman request client is missing");

        // When
        await Effect.runPromise(request({ method: "GET", path: "/containers/x/json" }));

        // Then
        expect(LIBPOD_API_PREFIX).toBe("/v6.0.0");
        expect(requests).toEqual(["GET /v6.0.0/containers/x/json HTTP/1.1"]);
      },
    );
  });

  test("pings and streams through the socket transport", async () => {
    await withSocketServer(
      (line) => httpResponse(line.includes("_ping") ? "OK" : '{"status":"start"}\n'),
      async ({ endpoint, requests }) => {
        // Given
        const client = makePodmanApiClient(endpoint, ctx);
        const stream = client.stream;
        if (stream === undefined) throw new Error("Podman stream client is missing");

        // When
        await Effect.runPromise(client.ping);
        const chunks = await Effect.runPromise(
          stream({ method: "GET", path: "/libpod/events" }).pipe(Stream.runCollect),
        );

        // Then
        expect(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("")).toBe(
          '{"status":"start"}\n',
        );
        expect(requests).toEqual(["GET /v6.0.0/libpod/_ping HTTP/1.1", "GET /v6.0.0/libpod/events HTTP/1.1"]);
      },
    );
  });

  test("classifies malformed transport responses as internal with provider context", async () => {
    await withSocketServer(
      () => "not-http",
      async ({ endpoint }) => {
        // Given
        const request = makePodmanApiClient(endpoint, ctx).request;
        if (request === undefined) throw new Error("Podman request client is missing");

        // When
        const exit = await Effect.runPromiseExit(request({ method: "GET", path: "/libpod/info" }));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("Expected typed failure");
        expect(exit.cause.error).toBeInstanceOf(ProviderInternalError);
        expect(exit.cause.error.providerId).toBe(ctx.providerId);
        expect(exit.cause.error.remediation).toBe(ctx.remediation);
      },
    );
  });

  test("classifies connection and capability failures with provider context", async () => {
    // Given
    const missing = join(tmpdir(), `missing-podman-${crypto.randomUUID()}.sock`);
    const client = makePodmanApiClient(missing, ctx);
    const request = client.request;
    if (request === undefined) throw new Error("Podman request client is missing");

    // When
    const requestExit = await Effect.runPromiseExit(request({ method: "GET", path: "/version" }));
    const infoExit = await Effect.runPromiseExit(client.info);

    // Then
    expect(Exit.isFailure(requestExit)).toBe(true);
    if (!Exit.isFailure(requestExit) || requestExit.cause._tag !== "Fail")
      throw new Error("Expected request failure");
    expect(requestExit.cause.error).toBeInstanceOf(ProviderUnavailableError);
    expect(requestExit.cause.error.providerId).toBe(ctx.providerId);
    expect(requestExit.cause.error.remediation).toBe(ctx.remediation);
    expect(Exit.isFailure(infoExit)).toBe(true);
    if (!Exit.isFailure(infoExit) || infoExit.cause._tag !== "Fail") throw new Error("Expected info failure");
    expect(infoExit.cause.error).toBeInstanceOf(ProviderUnavailableError);
    expect(infoExit.cause.error.providerId).toBe(ctx.providerId);
    expect(infoExit.cause.error.remediation).toBe(ctx.remediation);
  });

  test("reports malformed info JSON as a capability error", async () => {
    await withSocketServer(
      () => httpResponse("{"),
      async ({ endpoint }) => {
        // Given
        const client = makePodmanApiClient(endpoint, ctx);

        // When
        const exit = await Effect.runPromiseExit(client.info);

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail")
          throw new Error("Expected capability failure");
        expect(exit.cause.error).toBeInstanceOf(ProviderCapabilityError);
        if (!(exit.cause.error instanceof ProviderCapabilityError))
          throw new Error("Expected ProviderCapabilityError");
        expect(exit.cause.error.capability).toBe("podman-info");
        expect(exit.cause.error.providerId).toBe(ctx.providerId);
        expect(exit.cause.error.remediation).toBe(ctx.remediation);
      },
    );
  });
});
