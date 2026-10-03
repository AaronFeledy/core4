import { describe, expect, test } from "bun:test";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import {
  DOCKER_API_PREFIX,
  makeDockerApiClient,
  makeNamedPipeTransportClient,
  makeTcpTransportClient,
} from "../src/docker/api-client.ts";
import {
  ContainerTransportError,
  type SocketHttpConnection,
  normalizeNamedPipePath,
} from "../src/transport.ts";

const ctx = { providerId: "custom-docker", remediation: "Start the custom engine." } as const;

const connection = (writes: Array<string | Uint8Array>): SocketHttpConnection => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
  },
  write: (data) => {
    writes.push(data);
  },
  end: () => {},
  destroy: () => {},
});

describe("Docker API client", () => {
  test("constructs a lazy named-pipe client when given a Docker Desktop URI", () => {
    // Given / When
    const client = makeDockerApiClient("npipe:////./pipe/docker_engine", ctx);
    // Then: info is an Effect, not a function, in the existing EngineApiClient contract.
    expect(typeof client.request).toBe("function");
    expect(typeof client.stream).toBe("function");
    expect(Effect.isEffect(client.info)).toBe(true);
    expect(normalizeNamedPipePath("npipe:////./pipe/docker_engine")).toBe("\\\\.\\pipe\\docker_engine");
  });

  test("sends the versioned request when using the named-pipe transport", async () => {
    // Given
    const paths: string[] = [];
    const writes: Array<string | Uint8Array> = [];
    const client = makeNamedPipeTransportClient("\\\\.\\pipe\\docker_engine", async (path) => {
      paths.push(path);
      return connection(writes);
    });
    // When
    const response = await client.request({ method: "GET", path: "/info" });
    // Then
    expect(paths).toEqual(["\\\\.\\pipe\\docker_engine"]);
    expect(writes[0]).toStartWith("GET /v1.43/info HTTP/1.1\r\n");
    expect(response).toEqual({ status: 200, body: "{}" });
    expect(DOCKER_API_PREFIX).toBe("/v1.43");
  });

  test.each([
    ["http://127.0.0.1:2375/v1.43", "127.0.0.1", 2375],
    ["http://host/v1.43", "host", 80],
    ["https://host/v1.43", "host", 443],
  ] as const)("preserves the target port for %s", async (base, host, port) => {
    // Given
    const targets: unknown[] = [];
    const writes: Array<string | Uint8Array> = [];
    const client = makeTcpTransportClient(base, async (target) => {
      targets.push(target);
      return connection(writes);
    });
    // When
    await client.request({ method: "GET", path: "/info" });
    // Then
    expect(targets).toEqual([expect.objectContaining({ host, port })]);
    expect(writes[0]).toStartWith("GET /v1.43/info HTTP/1.1\r\n");
  });

  test("preserves host routing and socket-only streaming without opening sockets", async () => {
    // Given: these branches have no top-level connection injection by design.
    const source = await Bun.file(new URL("../src/docker/api-client.ts", import.meta.url)).text();
    // When
    const router = source.slice(source.indexOf("export const makeDockerApiClient ="));
    const unix = source.slice(
      source.indexOf("const makeUnixDockerApiClient ="),
      source.indexOf("const makeNamedPipeDockerApiClient ="),
    );
    // Then: structural characterization of non-injectable dispatch, not network execution.
    expect(router).toContain('dockerHost.startsWith("npipe:")');
    expect(router).toContain("normalizeNamedPipePath(dockerHost)");
    expect(router).toContain('dockerHost.startsWith("unix://")');
    expect(router).toContain('`http://${dockerHost.slice("tcp://".length)}${DOCKER_API_PREFIX}`');
    expect(unix.slice(0, unix.indexOf("request:"))).toContain("streamUnixSocketRequest(socketPath, input)");
    expect(unix.slice(unix.indexOf("stream: (input)"), unix.indexOf("request:"))).not.toContain("spawn");
  });

  test("parses the curl trailer when a Unix request uses injected spawn", async () => {
    // Given: only the subprocess fields consumed by this adapter are faked.
    const calls: unknown[][] = [];
    const spawn = new Proxy(Bun.spawn, {
      apply: (_target, _receiver, args: unknown[]) => {
        calls.push(args);
        return {
          stdout: new Blob(['{"ok":true}\n201']).stream(),
          stderr: new Blob([]).stream(),
          stdin: null,
          exited: Promise.resolve(0),
        };
      },
    });
    const request = makeDockerApiClient("unix:///var/run/docker.sock", ctx, { spawn }).request;
    if (request === undefined) throw new Error("Expected request client");
    // When
    const response = await Effect.runPromise(
      request({ method: "POST", path: "/containers/create", body: { Image: "test" } }),
    );
    // Then
    expect(response).toEqual({ status: 201, body: '{"ok":true}' });
    expect(calls).toEqual([
      [
        [
          "curl",
          "--silent",
          "--show-error",
          "--unix-socket",
          "/var/run/docker.sock",
          "--request",
          "POST",
          "--write-out",
          "\n%{http_code}",
          "--header",
          "Content-Type: application/json",
          "--data",
          '{"Image":"test"}',
          "http://localhost/v1.43/containers/create",
        ],
        { stderr: "pipe", stdin: "ignore", stdout: "pipe" },
      ],
    ]);
  });

  test.each(["parse", "connect", "write", "read", "http"] as const)(
    "maps %s transport errors with the supplied context",
    async (kind) => {
      // Given
      const cause = new ContainerTransportError({
        kind,
        operation: "transport",
        message: "Transport failed.",
      });
      const spawn = new Proxy(Bun.spawn, {
        apply: () => {
          throw cause;
        },
      });
      const request = makeDockerApiClient("/var/run/docker.sock", ctx, { spawn }).request;
      if (request === undefined) throw new Error("Expected request client");
      // When
      const error = await Effect.runPromise(request({ method: "GET", path: "/info" }).pipe(Effect.flip));
      // Then
      expect(error).toBeInstanceOf(kind === "parse" ? ProviderInternalError : ProviderUnavailableError);
      expect(error.providerId).toBe(ctx.providerId);
      expect(error.remediation).toBe(ctx.remediation);
      expect(error.cause).toBe(cause);
    },
  );
});
