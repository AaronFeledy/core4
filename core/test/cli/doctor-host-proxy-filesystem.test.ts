import { expect, test } from "bun:test";
import { chmod, chown, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHostProxyContainerDirectory } from "@lando/engine/subsystems/host-proxy/run-directory";
import { Effect } from "effect";
import { HostProxyDoctorFileSystem } from "../../src/cli/commands/doctor-host-proxy-filesystem.ts";

for (const kind of [
  "supported",
  "run-dir-0755",
  "container-0700",
  "container-symlink",
  "foreign-socket",
  "foreign-container",
  "legacy",
] as const) {
  test.skipIf(process.platform === "win32" || (kind.startsWith("foreign") && process.getuid?.() !== 0))(
    `doctor observes socket and directory privacy (${kind})`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-doctor-socket-"));
      const runDir = join(root, "run");
      const server = createServer();
      try {
        if (kind === "legacy") await mkdir(runDir, { mode: 0o700 });
        const directory = kind === "legacy" ? runDir : await ensureHostProxyContainerDirectory(runDir);
        const socketPath = join(directory, "sock");
        await new Promise<void>((resolve, reject) =>
          server.once("error", reject).listen(socketPath, resolve),
        );
        await chmod(socketPath, 0o666);
        switch (kind) {
          case "supported":
          case "legacy":
            break;
          case "run-dir-0755":
            await chmod(runDir, 0o755);
            break;
          case "container-0700":
            await chmod(directory, 0o700);
            break;
          case "container-symlink":
            await rename(directory, join(runDir, "target"));
            await symlink(join(runDir, "target"), directory);
            break;
          case "foreign-socket":
            await chown(socketPath, 65534, 65534);
            break;
          case "foreign-container":
            await chown(directory, 65534, 65534);
            break;
        }
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const filesystem = yield* HostProxyDoctorFileSystem;
            const metadata = yield* filesystem.socketMetadata(socketPath);
            const privateDirectory = yield* filesystem.socketDirectoryPrivate(
              socketPath,
              kind === "legacy" ? "run-directory" : "container",
            );
            return { metadata, privateDirectory };
          }).pipe(Effect.provide(HostProxyDoctorFileSystem.layer)),
        );
        expect(result).toEqual({
          metadata: { type: "socket", mode: 0o666, owned: kind !== "foreign-socket" },
          privateDirectory: kind === "supported" || kind === "foreign-socket" || kind === "legacy",
        });
      } finally {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
