import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  closeListeningServer,
  listenHostProxyServer,
} from "../../../src/subsystems/host-proxy/transport-listener.ts";

const setpriv = Bun.which("setpriv");
const curl = Bun.which("curl");

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0 || setpriv === null || curl === null)(
  "a non-root uid connects to the exposed socket while the host run directory stays private",
  async () => {
    if (setpriv === null || curl === null) throw new Error("Missing non-root test tools");
    // Given a private host socket whose inode is exposed separately, like a file bind in a service.
    const root = await mkdtemp(join(tmpdir(), "lando-nonroot-proxy-"));
    const directory = join(root, "private");
    const exposed = join(root, "service.sock");
    const socketPath = join(directory, "proxy.sock");
    const server = createServer((request, response) => {
      response.writeHead(request.headers.authorization === "Bearer test-capability" ? 200 : 401);
      response.end("host callback");
    });
    try {
      await chmod(root, 0o755);
      await mkdir(directory, { mode: 0o700 });
      await Effect.runPromise(
        listenHostProxyServer(
          server,
          {
            stateDir: directory,
            socketPath,
            shimPath: join(directory, "lando"),
            platform: "linux",
            transport: "unix-socket",
          },
          {},
        ),
      );
      await link(socketPath, exposed);
      // When an actual nobody process connects with the bearer capability.
      const child = Bun.spawn(
        [
          setpriv,
          "--reuid=65534",
          "--regid=65534",
          "--clear-groups",
          curl,
          "--silent",
          "--show-error",
          "--fail",
          "--max-time",
          "5",
          "--unix-socket",
          exposed,
          "--header",
          "Authorization: Bearer test-capability",
          "http://localhost/runLando",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then the real HTTP callback succeeds without granting host-directory access.
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "host callback", stderr: "" });
    } finally {
      await closeListeningServer(server);
      await rm(root, { recursive: true, force: true });
    }
  },
);
