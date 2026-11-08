import { describe, expect, test } from "bun:test";

import { chmod, chown, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  closeListeningServer,
  listenHostProxyServer,
} from "../../../src/subsystems/host-proxy/transport-listener.ts";

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

for (const kind of ["private", "permissive", "symlink", "foreign"] as const) {
  test.skipIf(process.platform === "win32" || (kind === "foreign" && process.getuid?.() !== 0))(
    `listener enforces the ${kind} run-directory boundary`,
    async () => {
      // Given a real run directory, including hostile existing directory variants.
      const root = await mkdtemp(join(tmpdir(), "lando-listener-privacy-"));
      const directory = join(root, "run");
      const server = createServer((_request, response) => response.end("reachable"));
      try {
        await mkdir(directory, { mode: 0o700 });
        switch (kind) {
          case "private":
            break;
          case "permissive":
            await chmod(directory, 0o755);
            break;
          case "symlink":
            await rm(directory, { recursive: true });
            await symlink(root, directory);
            break;
          case "foreign":
            await chown(directory, 65534, 65534);
            break;
        }
        const socketPath = join(directory, "proxy.sock");
        // When binding the listener.
        const result = await Effect.runPromiseExit(
          listenHostProxyServer(
            server,
            {
              stateDir: directory,
              socketPath,
              shimPath: join(directory, "lando"),
              platform: process.platform,
              transport: "unix-socket",
            },
            {},
          ),
        );
        // Then only a private directory publishes a connectable service socket.
        expect(result._tag).toBe(kind === "private" ? "Success" : "Failure");
        expect(server.listening).toBe(kind === "private");
        if (kind === "private") {
          const metadata = await lstat(socketPath);
          expect(metadata.isSocket()).toBe(true);
          expect(metadata.mode & 0o777).toBe(0o666);
        }
      } finally {
        await closeListeningServer(server);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
