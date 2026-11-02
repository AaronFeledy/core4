import { expect, test } from "bun:test";
import { lstat, mkdir, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { startDetachedAgentRelayWorker } from "../../../src/subsystems/ssh-agent/detached-worker.ts";
import { terminateOwnedAgentRelayWorker } from "../../../src/subsystems/ssh-agent/worker-state.ts";
import { relayHarness } from "./reuse-harness.ts";

test.each(["ssh", "gpg"] as const)(
  "%s replacement preserves mounted directory inodes and teardown disposes them",
  async (kind) => {
    // Given
    const relay = await relayHarness(kind, "bind-directory");
    try {
      await Effect.runPromise(startDetachedAgentRelayWorker(relay.options));
      const keyring = join(relay.sessionPaths.stateDir, "keyring");
      await mkdir(keyring, { mode: 0o700 });
      await writeFile(join(keyring, "pubring.gpg"), "public keys");
      await using socketHandle = await open(relay.sessionPaths.socketDir);
      await using keyringHandle = await open(keyring);
      const socketBefore = await socketHandle.stat();
      const keyringBefore = await keyringHandle.stat();
      // When
      const second = await Effect.runPromise(
        startDetachedAgentRelayWorker({
          ...relay.options,
          upstream: { _tag: "unix", path: "/changed/upstream" },
        }),
      );
      // Then
      expect((await stat(relay.sessionPaths.socketDir)).ino).toBe(socketBefore.ino);
      expect((await stat(keyring)).ino).toBe(keyringBefore.ino);
      expect((await stat(relay.sessionPaths.socketDir)).mode & 0o777).toBe(socketBefore.mode & 0o777);
      expect((await stat(keyring)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(relay.sessionPaths.socketDir, relay.options.socketName))).isSocket()).toBe(
        true,
      );
      expect(relay.state.spawned).toBe(2);
      await second.close();
      expect(
        await stat(relay.sessionPaths.stateDir).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        }),
      ).toBeUndefined();
    } finally {
      await relay.cleanup();
    }
  },
);

test("owned teardown removes the whole relay tree", async () => {
  // Given
  const relay = await relayHarness("gpg", "bind-directory");
  try {
    await Effect.runPromise(startDetachedAgentRelayWorker(relay.options));
    await mkdir(join(relay.sessionPaths.stateDir, "keyring"), { mode: 0o700 });
    // When
    await Effect.runPromise(terminateOwnedAgentRelayWorker(relay.options.app, relay.options));
    // Then
    expect(
      await stat(relay.sessionPaths.stateDir).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }),
    ).toBeUndefined();
    expect(relay.state.terminated).toBe(1);
  } finally {
    await relay.cleanup();
  }
});
