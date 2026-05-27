import { describe, expect, test } from "bun:test";

import { flushChunkedBufferAtEnd } from "@lando/provider-podman";

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
});
