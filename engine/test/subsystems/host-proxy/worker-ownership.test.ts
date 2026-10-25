import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { peekAdvisoryLockRecord } from "@lando/state-store/lock";
import { Effect } from "effect";
import { terminateOwnedHostProxyWorkersInRoot } from "../../../src/subsystems/host-proxy/worker-ownership.ts";

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
