import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { peekAdvisoryLockRecord } from "@lando/state-store/lock";
import { Effect } from "effect";
import { terminateOwnedHostProxyWorkersInRoot } from "../../../src/subsystems/host-proxy/worker-ownership.ts";
import { withAgentRelayWorkerLock } from "../../../src/subsystems/ssh-agent/worker-state.ts";

for (const state of ["absent", "untrusted"] as const) {
  test(`root sweep locks before inspecting and removing ${state} worker state`, async () => {
    // Given a disposable run directory with no trusted worker record.
    const root = await mkdtemp(join(tmpdir(), "lando-worker-sweep-"));
    const runDir = makeLandoPaths({ userDataRoot: root }).hostProxyRunDir("demo", root);
    const recordPath = join(runDir, "worker.json");
    await mkdir(runDir, { recursive: true });
    if (state === "untrusted") await writeFile(recordPath, "{}", { mode: 0o600 });
    const enforced: string[] = [];
    const observedOwners: number[] = [];
    try {
      // When sweeping, reject untrusted records only after observing their lock.
      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(root, {
          privateFileAccess: {
            enforce: async (path) => {
              enforced.push(path);
            },
            verify: async (path) => {
              if (path !== recordPath) return;
              for (const lockPath of enforced) {
                const record = await peekAdvisoryLockRecord(lockPath);
                if (record !== null) observedOwners.push(record.pid);
              }
              if (state === "untrusted") throw new Error("Untrusted worker record");
            },
          },
        }),
      );
      // Then inspection held a durable lock and cleanup released it.
      expect(observedOwners).toEqual([process.pid]);
      expect(enforced).toHaveLength(1);
      const lockPath = enforced[0];
      if (lockPath === undefined) throw new TypeError("Missing worker lock path");
      expect(dirname(lockPath)).toBe(join(root, "operation-locks"));
      expect(await readdir(dirname(lockPath))).toEqual([]);
      expect(await readdir(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["ssh", "gpg"] as const) {
  test(`host-proxy sweep leaves an in-flight ${kind} relay directory to its owner`, async () => {
    // Given a relay holding its own lock before publishing its worker record.
    const root = await mkdtemp(join(tmpdir(), "lando-agent-sweep-"));
    const paths = makeLandoPaths({ userDataRoot: root });
    const app = { id: "demo", root: AbsolutePath.make(root) };
    const runDir = paths.agentRelayRunDir(kind, app.id, app.root);
    const privateFileAccess = { enforce: async () => undefined, verify: async () => undefined };
    await mkdir(runDir, { recursive: true });
    try {
      // When host-proxy cleanup encounters that shared-root entry.
      await Effect.runPromise(
        withAgentRelayWorkerLock(
          app,
          { paths: { userDataRoot: root }, kind, privateFileAccess },
          terminateOwnedHostProxyWorkersInRoot(root, { privateFileAccess }),
        ),
      );
      // Then the relay's unpublished state directory remains intact.
      expect(await readdir(paths.hostProxyRunRoot)).toEqual([
        runDir.slice(paths.hostProxyRunRoot.length + 1),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("host-proxy sweep leaves the tunnel run directory to its owner", async () => {
  // Given tunnel state under the shared run root without a host-proxy record.
  const root = await mkdtemp(join(tmpdir(), "lando-tunnel-sweep-"));
  const paths = makeLandoPaths({ userDataRoot: root });
  await mkdir(paths.tunnelRunDir, { recursive: true });
  try {
    // When sweeping host-proxy workers.
    await Effect.runPromise(
      terminateOwnedHostProxyWorkersInRoot(root, {
        privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      }),
    );
    // Then tunnel state remains available to its owner.
    expect(await readdir(paths.hostProxyRunRoot)).toEqual(["tunnels"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
