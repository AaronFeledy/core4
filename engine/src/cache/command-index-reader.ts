import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluateVersionConstraints,
  isVersionConstraintEntryArray,
  isVersionConstraintSkipped,
} from "@lando/landofile/version-constraint";
import { sha256Hex } from "@lando/sdk/digest";
import {
  CacheError,
  type LandofileFormConflictError,
  type ToolingCommandUnavailableError,
} from "@lando/sdk/errors";
import { Effect } from "effect";
import { CORE_VERSION } from "../version.ts";
import {
  type AppCommandCacheSource,
  isMissingFile,
  resolveAppCommandCacheSource,
  sourceContentHash,
} from "./command-index-source.ts";
import { type AppCommandIndexPayload, decodeAppCommandIndex } from "./command-index.ts";
import { commandScriptsFresh } from "./command-script-freshness.ts";
import { appToolingCompilationCachePath, resolveUserCacheRoot } from "./paths.ts";

export type AppCommandCacheReadResult =
  | { readonly status: "fresh"; readonly payload: AppCommandIndexPayload }
  | { readonly status: "missing"; readonly sourcePath?: string }
  | { readonly status: "invalid"; readonly sourcePath: string }
  | {
      readonly status: "stale";
      readonly staleReason: NonNullable<ToolingCommandUnavailableError["staleReason"]>;
      readonly sourcePath: string;
    };

export interface ReadAppCommandCacheOptions {
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly includeScriptInventory?: boolean;
}

const readDetailed = async (
  options: ReadAppCommandCacheOptions,
  source: AppCommandCacheSource,
): Promise<AppCommandCacheReadResult> => {
  const appRoot = dirname(source.filePath);
  const sourcePath = source.filePath;
  const cachePath = appToolingCompilationCachePath(options.cacheRoot ?? resolveUserCacheRoot(), appRoot);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(cachePath);
  } catch (cause) {
    if (isMissingFile(cause)) return { status: "missing", sourcePath };
    throw cause;
  }
  const payload = decodeAppCommandIndex(bytes);
  if (payload === null) return { status: "invalid", sourcePath };
  if (payload.landoVersion !== CORE_VERSION)
    return { status: "stale", staleReason: "lando-version", sourcePath };
  if (payload.sourceFile !== sourcePath || !Array.isArray(payload.sourceLocalIncludePaths))
    return { status: "stale", staleReason: "source", sourcePath };
  if (!Array.isArray(payload.sourceReferencedFiles))
    return { status: "stale", staleReason: "referenced-file", sourcePath };
  for (const file of payload.sourceReferencedFiles) {
    let referenced: Uint8Array;
    try {
      referenced = await readFile(file.absolutePath);
    } catch (cause) {
      if (isMissingFile(cause)) return { status: "stale", staleReason: "referenced-file", sourcePath };
      throw cause;
    }
    if (referenced.byteLength !== file.size || sha256Hex(referenced) !== file.sha256)
      return { status: "stale", staleReason: "referenced-file", sourcePath };
  }
  if (!(await commandScriptsFresh(appRoot, payload.sourceScripts, options.includeScriptInventory)))
    return {
      status: "stale",
      staleReason: options.includeScriptInventory ? "script-inventory" : "script-metadata",
      sourcePath,
    };
  if (
    payload.sourceContentHash !== (await sourceContentHash(source, payload.sourceLocalIncludePaths, true)) ||
    payload.sourceMtimeMs !== source.stats.mtimeMs ||
    payload.sourceSize !== source.stats.size
  )
    return { status: "stale", staleReason: "source", sourcePath };
  if (!isVersionConstraintEntryArray(payload.versionConstraints))
    return { status: "stale", staleReason: "version-constraint", sourcePath };
  const evaluation = evaluateVersionConstraints(payload.versionConstraints, CORE_VERSION);
  if (
    evaluation.invalid.length > 0 ||
    (evaluation.unsatisfied.length > 0 && !isVersionConstraintSkipped(process.env))
  )
    return { status: "stale", staleReason: "version-constraint", sourcePath };
  return { status: "fresh", payload };
};

export const readAppCommandCacheForCwdDetailed = (
  options: ReadAppCommandCacheOptions = {},
): Effect.Effect<AppCommandCacheReadResult, CacheError | LandofileFormConflictError> =>
  resolveAppCommandCacheSource(options.cwd).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed<AppCommandCacheReadResult>({ status: "missing" })
        : Effect.tryPromise({
            try: () => readDetailed(options, source),
            catch: (cause) =>
              cause instanceof CacheError
                ? cause
                : new CacheError({
                    message: "Failed to read app-command metadata.",
                    key: "app-command",
                    cause,
                    remediation: "Check that the app sources and Lando cache are readable, then retry.",
                  }),
          }),
    ),
  );

export const readFreshAppCommandCacheForCwd = (
  options: ReadAppCommandCacheOptions = {},
): Effect.Effect<AppCommandIndexPayload | null, CacheError | LandofileFormConflictError> =>
  readAppCommandCacheForCwdDetailed(options).pipe(
    Effect.map((result) => {
      switch (result.status) {
        case "fresh":
          return result.payload;
        case "missing":
        case "stale":
        case "invalid":
          return null;
        default:
          return result satisfies never;
      }
    }),
  );
