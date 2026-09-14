import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childEnv } from "../core/src/cli/commands/bun-self-runner.ts";
import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";

export class PerformanceStoreCleanupError extends Error {
  override readonly name = "PerformanceStoreCleanupError";
}

export const unmountPerformanceOverlay =
  'status=0; mountpoint -q "$1/overlay" || status=$?; case "$status" in 0) umount "$1/overlay";; 32) :;; *) exit "$status";; esac';

export const acquirePerformanceStores = async (rootDir: string, key: string) => {
  const parent = join(rootDir, "samples");
  await mkdir(parent, { recursive: true });
  const sampleRoot = join(await realpath(parent), key);
  if (resolve(sampleRoot, "..") !== (await realpath(parent)))
    throw new PerformanceStoreCleanupError("Sample key must name a direct child of samples");
  await mkdir(sampleRoot, { mode: 0o700 });
  const runtimeRoot = await mkdtemp(join(await realpath(tmpdir()), "lp-"));
  const identities = await Promise.all([lstat(sampleRoot), lstat(runtimeRoot)]);
  const assertOwned = async () => {
    for (const [index, path] of [sampleRoot, runtimeRoot].entries()) {
      const stat = await lstat(path);
      const original = identities[index];
      if (
        stat.isSymbolicLink() ||
        (await realpath(path)) !== path ||
        stat.ino !== original?.ino ||
        stat.dev !== original.dev
      )
        throw new PerformanceStoreCleanupError(`Ownership changed; retaining ${path}`);
    }
  };
  return {
    sampleRoot,
    runtimeRoot,
    assertOwned,
    release: async (
      runCommand: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>,
      command: WorkflowPerformanceCommand,
    ) => {
      await assertOwned();
      const targets = [
        join(sampleRoot, "data/runtime/storage"),
        join(sampleRoot, "data/runtime/bin"),
        join(sampleRoot, "cache"),
      ];
      for (const target of targets) {
        try {
          if ((await realpath(target)) !== target)
            throw new PerformanceStoreCleanupError(`Store path changed; retaining ${target}`);
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
      }
      const storage = targets[0];
      if (storage === undefined) throw new PerformanceStoreCleanupError("Missing storage target");
      let storageExists = true;
      try {
        await lstat(storage);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        storageExists = false;
      }
      if (storageExists) {
        const result = await runCommand({
          ...command,
          id: "cleanup:storage",
          timeoutMs: 30_000,
          env: { ...command.env, CONTAINERS_CONF: join(sampleRoot, "data/runtime/config/containers.conf") },
          argv: [
            join(sampleRoot, "data/runtime/bin/podman"),
            "--root",
            storage,
            "--runroot",
            join(sampleRoot, "data/runtime/run"),
            "unshare",
            "sh",
            "-ec",
            `${unmountPerformanceOverlay}; rm -rf -- "$1"`,
            "sh",
            storage,
          ],
        });
        if (result.exitCode !== 0) return [result];
        const helpers = await runCommand({
          ...command,
          id: "cleanup:storage-helpers",
          timeoutMs: 30_000,
          argv: [
            process.execPath,
            join(import.meta.dir, "workflow-performance-runtime-cleanup.ts"),
            "--helpers-only",
          ],
          env: childEnv({ ...command.env }),
        });
        if (helpers.exitCode !== 0) return [helpers];
      }
      for (const target of targets.slice(1)) await rm(target, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true });
      return [];
    },
  };
};

export type PerformanceStores = Awaited<ReturnType<typeof acquirePerformanceStores>>;
