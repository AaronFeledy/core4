import { join } from "node:path";
import { posix } from "node:path";

import { FileNotFoundError, isErrnoCode } from "@lando/sdk/errors";
import { type BindMountPlan, VCS_SYNC_IGNORES, effectiveExcludes } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect, Schema } from "effect";

export const ShadowHostCheck = Schema.Struct({ path: Schema.String, shadowed: Schema.Boolean });
export type ShadowHostCheck = typeof ShadowHostCheck.Type;

export const effectiveShadowExcludes = (bind: BindMountPlan | undefined): readonly string[] =>
  bind === undefined
    ? []
    : effectiveExcludes(bind).filter(
        (entry) => !VCS_SYNC_IGNORES.some((vcs) => posix.normalize(entry).replace(/\/$/u, "") === vcs),
      );

export const canShadowHostPath = Effect.fnUntraced(function* (
  path: string,
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
): Effect.fn.Return<boolean> {
  if (fileSystem === undefined) return true;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((stat) => stat.isDirectory),
    Effect.catch((error) =>
      Effect.succeed(error instanceof FileNotFoundError || !isErrnoCode(error.cause, "ENOTDIR")),
    ),
  );
});

export const checkShadowHosts = Effect.fnUntraced(function* (
  appMount: BindMountPlan | undefined,
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
): Effect.fn.Return<readonly (ShadowHostCheck & { readonly exclude: string })[]> {
  if (appMount === undefined) return [];
  return yield* Effect.forEach(effectiveShadowExcludes(appMount), (exclude) => {
    const path = join(appMount.source, exclude);
    return canShadowHostPath(path, fileSystem).pipe(Effect.map((shadowed) => ({ exclude, path, shadowed })));
  });
});
