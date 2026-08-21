import { describe, expect, test } from "bun:test";

import type { Server } from "node:http";

import { closeListeningServer } from "../../../src/subsystems/host-proxy/transport-listener.ts";

describe("closeListeningServer", () => {
  test("waits for server.close to finish instead of racing the next event-loop turn", async () => {
    let closed = false;
    const server = {
      close: (callback?: (error?: Error) => void): Server => {
        setTimeout(() => {
          closed = true;
          callback?.();
        }, 20);
        return server as Server;
      },
    } as Server;

    await closeListeningServer(server);

    expect(closed).toBe(true);
  });
});
