import { expect, test } from "bun:test";
import { chmod, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { startDetachedAgentRelayWorker } from "../../../src/subsystems/ssh-agent/detached-worker.ts";
import { relayHarness } from "./reuse-harness.ts";

test.each(["public-mode", "symlink"] as const)(
  "rejects a %s record with production POSIX private file access before any control request",
  async (failure) => {
    // Given
    const relay = await relayHarness("ssh", "bind-directory");
    let identified = 0;
    try {
      await Effect.runPromise(startDetachedAgentRelayWorker(relay.options));
      if (failure === "public-mode") await chmod(relay.sessionPaths.recordPath, 0o644);
      else {
        const target = join(relay.root, "record-target");
        await rename(relay.sessionPaths.recordPath, target);
        await symlink(target, relay.sessionPaths.recordPath);
      }
      // When
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const privateFileAccess = yield* PrivateFileAccessService;
          return yield* Effect.result(
            startDetachedAgentRelayWorker({
              ...relay.options,
              privateFileAccess,
              identify: async () => {
                identified++;
                return relay.options.identify();
              },
            }),
          );
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      // Then
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SshAgentTransportError" } });
      expect(identified).toBe(0);
      expect(relay.state.terminated).toBe(0);
      expect(relay.state.spawned).toBe(1);
    } finally {
      await relay.cleanup();
    }
  },
);

test.each(["regular-file", "symlink"] as const)("replaces %s endpoints", async (endpointKind) => {
  // Given
  const relay = await relayHarness("ssh", "bind-directory");
  try {
    const first = await Effect.runPromise(startDetachedAgentRelayWorker(relay.options));
    const endpoint = join(relay.sessionPaths.socketDir, relay.options.socketName);
    if (endpointKind === "regular-file") {
      await relay.closeEndpoints();
      await rm(endpoint, { force: true });
      await writeFile(endpoint, "not a socket");
    } else {
      const target = join(relay.sessionPaths.socketDir, "other.sock");
      await rename(endpoint, target);
      await symlink(target, endpoint);
    }
    // When
    const second = await Effect.runPromise(startDetachedAgentRelayWorker(relay.options));
    // Then
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(relay.state.spawned).toBe(2);
    expect(relay.state.terminated).toBe(1);
  } finally {
    await relay.cleanup();
  }
});
