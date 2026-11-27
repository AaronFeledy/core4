import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { HostTreeCopyGuard } from "@lando/data-mover/host-tree-copy-guard";
import { isLocalOverrideLayer, landofileLayerPaths } from "@lando/landofile/layers";
import { OperationDiscovery, withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import type { selectLandofileRoot } from "@lando/landofile/service";
import { tryPromiseSettled } from "@lando/sdk/abortable-promise";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { DataTransferError, ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, type DataTransferSpec } from "@lando/sdk/schema";
import type { DataMover } from "@lando/sdk/services";
import { Effect } from "effect";
import type { AdmittedFork } from "./fork-source.ts";

const DEFAULT_SCRATCH_EXCLUDES = [".git/", "node_modules/", "vendor/", ".lando/cache/", ".DS_Store"] as const;

export const copyScratchFork = (
  source: Effect.Success<ReturnType<typeof selectLandofileRoot>>,
  target: {
    readonly root: AbsolutePath;
    readonly excludes: readonly string[];
    readonly omitLocalOverrides: boolean;
    readonly admitted?: AdmittedFork | undefined;
  },
  mover: typeof DataMover.Service,
) => {
  const { appRoot, lockfile, layers } = source;
  const { root, admitted } = target;
  const omitted = new Set(
    target.omitLocalOverrides
      ? landofileLayerPaths(root)
          .filter(isLocalOverrideLayer)
          .flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath])
      : [],
  );
  const protectedFiles = new Set([basename(lockfile), ...layers.map(({ filePath }) => basename(filePath))]);
  const transfer: DataTransferSpec = {
    from: { _tag: "hostPath", path: AbsolutePath.make(appRoot) },
    to: { _tag: "hostPath", path: root },
    overwrite: true,
  };
  const copy = Effect.scoped(mover.transfer(transfer));
  const guarded =
    admitted === undefined
      ? withDiscoveryCwd(appRoot, copy)
      : admitted.verify.pipe(
          Effect.andThen(
            copy.pipe(
              Effect.provideService(HostTreeCopyGuard, {
                transfer,
                verify: admitted.verify.pipe(
                  mapFailures(
                    (cause) =>
                      new DataTransferError({
                        operation: "verify-host-tree-source",
                        message: cause.message,
                        remediation: cause.remediation,
                        cause,
                      }),
                  ),
                ),
              }),
            ),
          ),
          Effect.andThen(admitted.verify),
          Effect.provideService(OperationDiscovery, admitted.discovery),
        );
  const materialize = guarded.pipe(
    mapFailures((cause) => {
      if (cause instanceof ScratchAppError) return cause;
      if (
        cause instanceof DataTransferError &&
        cause.operation === "verify-host-tree-source" &&
        cause.cause instanceof ScratchAppError
      )
        return cause.cause;
      return new ScratchAppError({
        operation: "materialize",
        message: `Unable to copy the source app root into the scratch app at ${root}.`,
        cause,
        remediation: causeRemediation(cause) ?? "Check that the source app is readable, then retry.",
      });
    }),
  );
  const prune = tryPromiseSettled({
    try: async (signal) => {
      const patterns = [...DEFAULT_SCRATCH_EXCLUDES, ...target.excludes].map((pattern) =>
        pattern.replace(/^\.\//u, ""),
      );
      const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (signal.aborted) return;
          const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
          const path = join(directory, entry.name);
          if (protectedFiles.has(relative)) continue;
          const excluded = patterns.some((pattern) => {
            const directoryOnly = pattern.endsWith("/");
            const normalized = directoryOnly ? pattern.slice(0, -1) : pattern;
            if (directoryOnly && normalized === ".git") return entry.name === ".git";
            if (directoryOnly && !entry.isDirectory()) return false;
            if (!normalized.includes("/") && !normalized.includes("*")) return entry.name === normalized;
            return new Bun.Glob(normalized).match(relative);
          });
          if (omitted.has(path) || excluded) await rm(path, { recursive: true, force: true });
          else if (entry.isDirectory()) await visit(path, relative);
        }
      };
      await visit(root, "");
    },
    catch: (cause) =>
      new ScratchAppError({
        operation: "materialize",
        message: `Unable to apply scratch copy exclusions under ${root}.`,
        cause,
        remediation: "Check that the scratch copy is writable, then retry.",
      }),
  });
  return materialize.pipe(Effect.andThen(prune));
};
