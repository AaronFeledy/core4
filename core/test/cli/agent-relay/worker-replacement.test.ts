import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDetachedAgentRelayWorker } from "@lando/engine/subsystems/ssh-agent/detached-worker";
import { type AgentRelaySession, sshAgentSessionPaths } from "@lando/engine/subsystems/ssh-agent/session";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

test.each(["ssh", "gpg"] as const)(
  "real %s replacement keeps mounted directories",
  async (kind) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "relay-replace-"));
    const upstreams = [
      createServer((socket) => socket.end("first")),
      createServer((socket) => socket.end("second")),
    ];
    let session: AgentRelaySession | undefined;
    try {
      for (const [index, server] of upstreams.entries()) {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(join(root, `upstream-${index}.sock`), resolve);
        });
      }
      const privateFileAccess = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* PrivateFileAccessService;
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      const app = { kind: "user" as const, id: "replace", root: AbsolutePath.make(root) };
      const options = {
        app,
        kind,
        plan: { id: AppId.make(app.id), provider: ProviderId.make("docker") },
        upstream: { _tag: "unix" as const, path: join(root, "upstream-0.sock") },
        delivery: "bind-directory" as const,
        socketName: "agent.sock",
        paths: { userDataRoot: root },
        privateFileAccess,
      };
      session = await Effect.runPromise(startDetachedAgentRelayWorker(options));
      const paths = sshAgentSessionPaths(app, options.paths, kind);
      const keyring = join(paths.stateDir, "keyring");
      await mkdir(keyring, { mode: 0o700 });
      await writeFile(join(keyring, "pubring.gpg"), "public material");
      await using socketDir = await open(paths.socketDir);
      await using keyringDir = await open(keyring);
      const directoryMode = (await socketDir.stat()).mode & 0o777;
      const first = session;
      // When
      session = await Effect.runPromise(
        startDetachedAgentRelayWorker({
          ...options,
          upstream: { _tag: "unix", path: join(root, "upstream-1.sock") },
        }),
      );
      const reply = await new Promise<string>((resolve, reject) => {
        const client = connect(join(paths.socketDir, options.socketName));
        let text = "";
        client.on("data", (chunk) => {
          text += chunk.toString();
        });
        client.once("end", () => resolve(text));
        client.once("error", reject);
        client.setTimeout(2_000, () => client.destroy(new Error("Relay did not forward data")));
      });
      // Then
      expect(reply).toBe("second");
      expect(session.sessionId).not.toBe(first.sessionId);
      expect((await stat(paths.socketDir)).ino).toBe((await socketDir.stat()).ino);
      expect((await stat(keyring)).ino).toBe((await keyringDir.stat()).ino);
      expect((await stat(paths.socketDir)).mode & 0o777).toBe(directoryMode);
      expect((await stat(join(paths.socketDir, options.socketName))).mode & 0o777).toBe(0o666);
      await first.close();
      await session.close();
      expect(await Bun.file(paths.recordPath).exists()).toBe(false);
    } finally {
      await session?.close();
      await Promise.all(
        upstreams.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
