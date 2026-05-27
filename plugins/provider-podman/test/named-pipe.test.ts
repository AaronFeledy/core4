import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { Cause, Effect } from "effect";

import { decodeChunkedBody, flushChunkedBufferAtEnd, makeRuntimeProvider } from "@lando/provider-podman";
import { connectNamedPipeSocket, namedPipeInfoFailure } from "../src/named-pipe.ts";

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

  test("decodes the final chunk when the trailing CRLF is missing at end-of-stream", async () => {
    const body = new TextEncoder().encode("5\r\nhello");

    const chunks = await Array.fromAsync(
      decodeChunkedBody(
        (async function* () {
          yield body;
        })(),
      ),
    );

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

  test("maps named-pipe info connection failures to machine-not-running remediation", async () => {
    const connectFailure = Object.assign(new Error("connect ENOENT \\.\\pipe\\podman-machine-default"), {
      code: "ENOENT",
    });

    const exit = await Effect.runPromiseExit(
      makeRuntimeProvider({
        platform: "win32",
        socketPath: "npipe://./pipe/lando-missing-podman-machine",
        podmanApi: { info: Effect.fail(namedPipeInfoFailure(connectFailure)) },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value.operation).toBe("machine");
        expect(failure.value.message).toContain("podman-machine-default");
        expect(failure.value.remediation).toContain("podman machine start");
      }
    }
  });
});
