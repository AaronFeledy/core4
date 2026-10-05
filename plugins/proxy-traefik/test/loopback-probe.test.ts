import { expect, test } from "bun:test";

import { probeHttp, probeTcp } from "../src/loopback-probe.ts";

test("TCP distinguishes an open listener from a refused connection", async () => {
  // Given: an ephemeral loopback listener and a port whose listener has closed.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const closedPort = Number(closed.url.port);
  await closed.stop(true);
  try {
    // When
    const results = await Promise.all([
      probeTcp({ port: Number(server.url.port), timeoutMs: 200 }),
      probeTcp({ host: "127.0.0.1", port: closedPort, timeoutMs: 200 }),
    ]);
    // Then
    expect(results).toEqual(["open", "refused"]);
  } finally {
    await server.stop(true);
  }
});

test("HTTP accepts an error status response but rejects a refused connection", async () => {
  // Given: an HTTP listener returning a status and a port whose listener has closed.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("", { status: 503 }),
  });
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const closedPort = Number(closed.url.port);
  await closed.stop(true);
  try {
    // When
    const results = await Promise.all([
      probeHttp({ port: Number(server.url.port), role: "http", timeoutMs: 500 }),
      probeHttp({ host: "127.0.0.1", port: closedPort, role: "http", timeoutMs: 500 }),
    ]);
    // Then
    expect(results).toEqual([true, false]);
  } finally {
    await server.stop(true);
  }
});
