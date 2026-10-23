import { join } from "node:path";

import { FileNotFoundError, isErrnoCode } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect, Schema } from "effect";

export const ShadowHostCheck = Schema.Struct({ path: Schema.String, shadowed: Schema.Boolean });
export type ShadowHostCheck = typeof ShadowHostCheck.Type;

export const effectiveShadowExcludes = (appMount: ServicePlan["appMount"]): readonly string[] => {
  const includes = new Set(appMount?.includes ?? []);
  return (appMount?.excludes ?? []).filter((entry) => !entry.startsWith("!") && !includes.has(entry));
};

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
  appMount: ServicePlan["appMount"],
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
): Effect.fn.Return<readonly (ShadowHostCheck & { readonly exclude: string })[]> {
  if (appMount === undefined) return [];
  return yield* Effect.forEach(effectiveShadowExcludes(appMount), (exclude) => {
    const path = join(appMount.source, exclude);
    return canShadowHostPath(path, fileSystem).pipe(Effect.map((shadowed) => ({ exclude, path, shadowed })));
  });
});
