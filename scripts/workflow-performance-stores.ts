import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";

export class PerformanceStoreCleanupError extends Error {
  override readonly name = "PerformanceStoreCleanupError";
}

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
          argv: [
            join(sampleRoot, "data/runtime/bin/podman"),
            "--root",
            storage,
            "--runroot",
            join(sampleRoot, "data/runtime/run"),
            "unshare",
            "rm",
            "-rf",
            "--",
            storage,
          ],
        });
        if (result.exitCode !== 0) return [result];
      }
      for (const target of targets.slice(1)) await rm(target, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true });
      return [];
    },
  };
};

export type PerformanceStores = Awaited<ReturnType<typeof acquirePerformanceStores>>;
