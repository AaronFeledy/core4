import { describe, expect, test } from "bun:test";

import {
  ContainerTransportError,
  type SocketHttpConnection,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "@lando/container-runtime/transport";

type Bytes = Uint8Array<ArrayBufferLike>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Bytes => encoder.encode(value);

class FakeConnection implements SocketHttpConnection {
  readonly writes: Array<string> = [];
  destroyed = false;

  constructor(private readonly chunks: ReadonlyArray<Bytes>) {}

  write(data: string | Uint8Array): void {
    this.writes.push(typeof data === "string" ? data : decoder.decode(data));
  }

  destroy(): void {
    this.destroyed = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Bytes> {
    for (const chunk of this.chunks) yield chunk;
  }
}

describe("socket HTTP transport", () => {
  test("serializes requests and parses responses whose headers arrive in pieces", async () => {
    const connection = new FakeConnection([
      bytes("HTTP/1.1 200"),
      bytes(" OK\r\nContent-Length: 2\r\n\r\n{}"),
    ]);
    const client = makeSocketHttpClient({
      apiPrefix: "/v5.0.0",
      connect: async () => connection,
      hostHeader: "localhost",
    });

    const response = await client.request({ method: "POST", path: "/libpod/info", body: { ok: true } });

    expect(response).toEqual({ status: 200, body: "{}" });
    expect(connection.writes[0]).toStartWith("POST /v5.0.0/libpod/info HTTP/1.1\r\n");
    expect(connection.writes[0]).toContain("Host: localhost\r\n");
    expect(connection.writes[0]).toContain("Content-Type: application/json\r\n");
    expect(connection.writes[0]).toContain("Content-Length: 11\r\n");
    expect(connection.writes[0]).toEndWith('\r\n\r\n{"ok":true}');
    expect(connection.destroyed).toBe(true);
  });

  test("assembles chunked response bodies split across socket chunks", async () => {
    const connection = new FakeConnection([
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe"),
      bytes("llo\r\n6\r\n wor"),
      bytes("ld\r\n0\r\n\r\n"),
    ]);
    const client = makeSocketHttpClient({ apiPrefix: "/v1.43", connect: async () => connection });

    const response = await client.request({ method: "GET", path: "/info" });

    expect(response).toEqual({ status: 200, body: "hello world" });
  });

  test("streams connection-close response bodies without content-length", async () => {
    const first = bytes("first");
    const second = bytes("second");
    const connection = new FakeConnection([bytes("HTTP/1.1 200 OK\r\n\r\n"), first, second]);
    const client = makeSocketHttpClient({ apiPrefix: "/v1.43", connect: async () => connection });

    const chunks = await Array.fromAsync(client.stream({ method: "GET", path: "/events" }));

    expect(chunks).toEqual([first, second]);
  });

  test("throws a neutral transport error for malformed status lines", async () => {
    const connection = new FakeConnection([bytes("HTTP/1.1 OK\r\n\r\n{}")]);
    const client = makeSocketHttpClient({ apiPrefix: "/v1.43", connect: async () => connection });

    await expect(client.request({ method: "GET", path: "/info" })).rejects.toBeInstanceOf(
      ContainerTransportError,
    );
  });

  test("normalizes Docker and Podman Desktop named-pipe URIs", () => {
    expect(normalizeNamedPipePath("npipe://./pipe/docker_engine")).toBe("\\\\.\\pipe\\docker_engine");
    expect(normalizeNamedPipePath("npipe:////./pipe/podman-machine-default")).toBe(
      "\\\\.\\pipe\\podman-machine-default",
    );
    expect(normalizeNamedPipePath("/tmp/podman.sock")).toBe("/tmp/podman.sock");
  });
});
