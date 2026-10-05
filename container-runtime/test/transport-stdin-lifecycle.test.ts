import { expect, test } from "bun:test";

import { type SocketHttpConnection, makeSocketHttpClient } from "@lando/container-runtime/transport";

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
