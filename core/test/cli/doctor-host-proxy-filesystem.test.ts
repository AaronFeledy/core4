import { expect, test } from "bun:test";
import { chmod, chown, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { HostProxyDoctorFileSystem } from "../../src/cli/commands/doctor-host-proxy-filesystem.ts";

for (const kind of ["private", "permissive", "symlink", "foreign-socket", "foreign-directory"] as const) {
  test.skipIf(process.platform === "win32" || (kind.startsWith("foreign") && process.getuid?.() !== 0))(
    `doctor observes socket and directory privacy (${kind})`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-doctor-socket-"));
      const directory = join(root, "run");
      const socketPath = join(directory, "proxy.sock");
      const server = createServer();
      try {
        await mkdir(directory, { mode: 0o700 });
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
        await chmod(socketPath, 0o666);
        let inspectedPath = socketPath;
        switch (kind) {
          case "private":
            break;
          case "permissive":
            await chmod(directory, 0o755);
            break;
          case "symlink":
            await symlink(directory, join(root, "alias"));
            inspectedPath = join(root, "alias", "proxy.sock");
            break;
          case "foreign-socket":
            await chown(socketPath, 65534, 65534);
            break;
          case "foreign-directory":
            await chown(directory, 65534, 65534);
            break;
        }
        const metadata = await Effect.runPromise(
          Effect.gen(function* () {
            const filesystem = yield* HostProxyDoctorFileSystem;
            return yield* filesystem.socketMetadata(inspectedPath);
          }).pipe(Effect.provide(HostProxyDoctorFileSystem.layer)),
        );
        expect(metadata).toMatchObject({
          type: "socket",
          mode: 0o666,
          owned: kind !== "foreign-socket",
          privateDirectory: kind === "private" || kind === "foreign-socket",
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
