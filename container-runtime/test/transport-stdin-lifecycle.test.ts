import { expect, test } from "bun:test";
import { Socket } from "node:net";

import {
  type SocketHttpConnection,
  makeSocketHttpClient,
  socketHttpConnection,
} from "@lando/container-runtime/transport";

test.each([false, true])(
  "returns the active stdin reader on attach completion (aborted=%s)",
  async (aborted) => {
    // Given
    const reading = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const controller = new AbortController();
    let returns = 0;
    let destroyed = false;
    const connection: SocketHttpConnection = {
      write: () => {},
      end: () => {},
      destroy: () => {
        destroyed = true;
        closed.resolve();
      },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(
          "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
        );
        if (aborted) await closed.promise;
      },
    };
    const stdin: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reading.resolve();
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return: async () => {
          returns++;
          return { done: true, value: undefined };
        },
      }),
    };
    const client = makeSocketHttpClient({ apiPrefix: "/v1.43", connect: async () => connection });
    // When
    const result = Array.fromAsync(
      client.stream({ method: "POST", path: "/exec/abc/start", stdin, signal: controller.signal }),
    );
    await reading.promise;
    if (aborted) {
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    } else {
      expect(await result).toEqual([]);
    }
    // Then
    expect(returns).toBe(1);
    expect(destroyed).toBe(true);
  },
);

test("stops a pending stdin reader after a post-head peer reset", async () => {
  // Given
  const reading = Promise.withResolvers<void>();
  let returns = 0;
  const connection: SocketHttpConnection = {
    write: () => {},
    end: () => {},
    destroy: () => {},
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode("HTTP/1.1 101 UPGRADED\r\n\r\n");
      await reading.promise;
      throw Object.assign(new Error("peer reset"), { code: "ECONNRESET" });
    },
  };
  const stdin: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        reading.resolve();
        return new Promise<IteratorResult<Uint8Array>>(() => {});
      },
      return: async () => {
        returns++;
        return { done: true, value: undefined };
      },
    }),
  };
  const client = makeSocketHttpClient({ apiPrefix: "/v6.0.0", connect: async () => connection });
  // When
  const result = Array.fromAsync(client.stream({ method: "POST", path: "/exec/abc/start", stdin }));
  // Then
  await expect(result).rejects.toMatchObject({ kind: "read", systemCode: "ECONNRESET" });
  expect(returns).toBe(1);
});

test("guards closed socket writes and handles late writer error events", () => {
  // Given
  const socket = new Socket();
  const connection = socketHttpConnection(socket);
  socket.destroy();
  // When
  connection.write(new Uint8Array([1]));
  connection.end();
  const handled = socket.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  // Then
  expect(handled).toBe(true);
  expect(socket.writableLength).toBe(0);
});
