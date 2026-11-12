import { describe, expect, test } from "bun:test";

import {
  ContainerTransportError,
  type SocketHttpConnection,
  makeSocketHttpClient,
} from "@lando/container-runtime/transport";

type Bytes = Uint8Array<ArrayBufferLike>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Bytes => encoder.encode(value);

async function* uploadBytes(...values: ReadonlyArray<string>): AsyncGenerator<Bytes> {
  for (const value of values) yield bytes(value);
}

class UploadConnection implements SocketHttpConnection {
  readonly writes: Array<string | Uint8Array> = [];
  destroyed = false;
  ended = false;

  constructor(
    private readonly response: ReadonlyArray<Bytes>,
    private readonly bodyWrite?: Promise<void>,
  ) {}

  write(data: string | Uint8Array): void | Promise<void> {
    this.writes.push(data);
    return typeof data === "string" ? undefined : this.bodyWrite;
  }

  destroy(): void {
    this.destroyed = true;
  }

  end(): void {
    this.ended = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Bytes> {
    for (const chunk of this.response) yield chunk;
  }
}

/** A peer that stopped reading: the body write settles only when the connection is destroyed. */
class StalledWriteConnection extends UploadConnection {
  readonly #stalled = Promise.withResolvers<void>();

  override write(data: string | Uint8Array): void | Promise<void> {
    this.writes.push(data);
    return typeof data === "string" ? undefined : this.#stalled.promise;
  }

  override destroy(): void {
    super.destroy();
    this.#stalled.reject(new Error("socket destroyed"));
  }
}

const clientFor = (connection: SocketHttpConnection, onConnect?: () => void) =>
  makeSocketHttpClient({
    apiPrefix: "/v1.43",
    connect: async () => {
      onConnect?.();
      return connection;
    },
  });

const buildRequest = (
  upload: AsyncIterable<Bytes>,
  signal?: AbortSignal,
): Parameters<ReturnType<typeof clientFor>["stream"]>[0] => ({
  method: "POST",
  path: "/build",
  headers: { "Content-Type": "application/x-tar" },
  upload,
  ...(signal === undefined ? {} : { signal }),
});

const collectFailure = async (response: AsyncIterable<Bytes>): Promise<ContainerTransportError> => {
  try {
    await Array.fromAsync(response);
  } catch (cause) {
    if (cause instanceof ContainerTransportError) return cause;
    throw cause;
  }
  throw new Error("expected a transport error");
};

describe("socket HTTP transport upload bodies", () => {
  test("sends the collected body with one Content-Length and no upgrade headers", async () => {
    // Given
    const connection = new UploadConnection([
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"),
    ]);
    const client = clientFor(connection);

    // When
    const chunks = await Array.fromAsync(client.stream(buildRequest(uploadBytes("tar", "ball"))));

    // Then
    expect(decoder.decode(chunks[0])).toBe("{}");
    const head = connection.writes[0];
    if (typeof head !== "string") throw new Error("expected the request head to be text");
    expect(head).toStartWith("POST /v1.43/build HTTP/1.1\r\n");
    expect(head).toContain("Content-Type: application/x-tar\r\n");
    expect(head).toContain("Content-Length: 7\r\n");
    expect(head.match(/Content-Length:/gu)).toHaveLength(1);
    expect(head).toContain("Connection: close\r\n");
    expect(head).not.toContain("Upgrade:");
    expect(head).not.toContain("Expect:");
    expect(connection.writes[1]).toEqual(bytes("tarball"));
    expect(connection.ended).toBe(false);
    expect(connection.destroyed).toBe(true);
  });

  test("yields response bytes while the body write is still pending", async () => {
    // Given: the body write stays pending until released, and the response is already complete.
    const write = Promise.withResolvers<void>();
    const connection = new UploadConnection(
      [bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n0\r\n\r\n")],
      write.promise,
    );
    const client = clientFor(connection);
    const iterator = client.stream(buildRequest(uploadBytes("payload")))[Symbol.asyncIterator]();

    // When: only the first response chunk is read before the write is released.
    const first = await iterator.next();

    // Then
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("first");
    expect(connection.writes).toHaveLength(2);

    write.resolve();
    const remaining = await Array.fromAsync({ [Symbol.asyncIterator]: () => iterator });
    expect(remaining).toEqual([]);
    expect(connection.destroyed).toBe(true);
  });

  test("keeps the HTTP diagnostic when the body write fails", async () => {
    // Given
    const write = Promise.withResolvers<void>();
    void write.promise.catch(() => undefined);
    write.reject(new Error("socket write failed"));
    const connection = new UploadConnection(
      [bytes("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\n\r\n{}")],
      write.promise,
    );
    const client = clientFor(connection);

    // When
    const caught = await collectFailure(client.stream(buildRequest(uploadBytes("payload"))));

    // Then
    expect(caught).toBeInstanceOf(ContainerTransportError);
    expect(caught.kind).toBe("http");
    expect(caught.details).toEqual({
      method: "POST",
      path: "/build",
      status: 500,
      body: "{}",
    });
    expect(connection.destroyed).toBe(true);
  });

  test("reports an early non-2xx response when the peer never drains the body", async () => {
    // Given: the daemon answers 400 without reading the upload, so the body write never completes.
    const connection = new StalledWriteConnection([
      bytes('HTTP/1.1 400 Bad Request\r\nContent-Length: 17\r\n\r\n{"message":"bad"}'),
    ]);
    const client = clientFor(connection);

    // When
    const caught = await collectFailure(client.stream(buildRequest(uploadBytes("payload"))));

    // Then: cleanup destroys the connection instead of waiting on the stalled write.
    expect(caught.kind).toBe("http");
    expect(caught.details).toEqual({
      method: "POST",
      path: "/build",
      status: 400,
      body: '{"message":"bad"}',
    });
    expect(connection.destroyed).toBe(true);
  });

  test("fails an upload response whose chunked body ends without its terminal chunk", async () => {
    // Given
    const connection = new UploadConnection([
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello"),
    ]);
    const client = clientFor(connection);

    // When
    const caught = await collectFailure(client.stream(buildRequest(uploadBytes("payload"))));

    // Then
    expect(caught).toBeInstanceOf(ContainerTransportError);
    expect(caught.kind).toBe("read");
  });

  test("fails an upload response whose Content-Length body ends short", async () => {
    // Given
    const connection = new UploadConnection([bytes("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort")]);
    const client = clientFor(connection);

    // When
    const caught = await collectFailure(client.stream(buildRequest(uploadBytes("payload"))));

    // Then
    expect(caught).toBeInstanceOf(ContainerTransportError);
    expect(caught.kind).toBe("read");
  });

  test("returns a complete chunked upload response", async () => {
    // Given
    const connection = new UploadConnection([
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n4\r\n bye\r\n0\r\n\r\n"),
    ]);
    const client = clientFor(connection);

    // When
    const chunks = await Array.fromAsync(client.stream(buildRequest(uploadBytes("payload"))));

    // Then
    expect(chunks.map((chunk) => decoder.decode(chunk))).toEqual(["hi", " bye"]);
  });

  test("stops collecting the upload on abort and never connects", async () => {
    // Given
    let connected = 0;
    const started = Promise.withResolvers<void>();
    let returned = false;
    const upload: AsyncIterable<Bytes> = {
      [Symbol.asyncIterator]: () => {
        let calls = 0;
        return {
          next: () => {
            calls += 1;
            if (calls > 1) {
              started.resolve();
              return new Promise<IteratorResult<Bytes>>(() => {});
            }
            return Promise.resolve({ done: false, value: bytes("partial") });
          },
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const client = clientFor(new UploadConnection([]), () => {
      connected += 1;
    });

    // When
    const streaming = Array.fromAsync(client.stream(buildRequest(upload, controller.signal)));
    await started.promise;
    controller.abort();

    // Then
    await expect(streaming).rejects.toMatchObject({ name: "AbortError" });
    expect(connected).toBe(0);
    expect(returned).toBe(true);
  });

  test("never connects when the signal is already aborted", async () => {
    // Given
    let connected = 0;
    const controller = new AbortController();
    controller.abort();
    const client = clientFor(new UploadConnection([]), () => {
      connected += 1;
    });

    // When/Then
    await expect(
      Array.fromAsync(client.stream(buildRequest(uploadBytes("payload"), controller.signal))),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(connected).toBe(0);
  });

  test("keeps tolerant end-of-stream handling for streams without an upload", async () => {
    // Given: the chunked body has no terminal zero chunk.
    const connection = new UploadConnection([
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello"),
    ]);
    const client = clientFor(connection);

    // When
    const chunks = await Array.fromAsync(client.stream({ method: "GET", path: "/events" }));

    // Then
    expect(chunks.map((chunk) => decoder.decode(chunk))).toEqual(["hello"]);
  });
});
