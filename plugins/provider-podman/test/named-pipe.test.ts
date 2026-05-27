import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { flushChunkedBufferAtEnd } from "@lando/provider-podman";
import { connectNamedPipeSocket } from "../src/named-pipe.ts";

describe("provider-podman named-pipe chunk flush", () => {
  test("keeps the final chunk even when the trailing CRLF is missing at end-of-stream", () => {
    const body = new TextEncoder().encode("5\r\nhello");

    const chunks = flushChunkedBufferAtEnd(body);

    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
  });

  test("keeps complete chunked frames unchanged", () => {
    const body = new TextEncoder().encode("5\r\nhello\r\n0\r\n\r\n");

    const chunks = flushChunkedBufferAtEnd(body);

    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
  });

  test("destroys the socket when named-pipe connection fails before connect", async () => {
    class FailingSocket extends EventEmitter {
      destroyedByClient = false;

      destroy(): this {
        this.destroyedByClient = true;
        return this;
      }
    }

    const socket = new FailingSocket();
    const failure = new Error("connect ENOENT");

    const connected = connectNamedPipeSocket(socket as unknown as Socket);
    socket.emit("error", failure);

    await expect(connected).rejects.toBe(failure);
    expect(socket.destroyedByClient).toBe(true);
  });
});
