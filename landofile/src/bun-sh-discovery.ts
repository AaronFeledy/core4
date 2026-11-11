import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Result } from "effect";

import {
  type BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  type NotImplementedError,
  causeMessage,
  isErrnoCode,
} from "@lando/sdk/errors";
import type { BunShellScriptFrontMatter } from "@lando/sdk/schema";
import type { BunShellFrontMatterProblem } from "./bun-sh-frontmatter.ts";
import { BUN_SHELL_SCRIPT_EXTENSION, canonicalIdFromRelativePath } from "./bun-sh-identity.ts";
export { BUN_SHELL_SCRIPT_EXTENSION, canonicalIdFromRelativePath } from "./bun-sh-identity.ts";
import { inspectScriptContent, readScriptContent, scriptServiceProblem } from "./bun-sh-inspection.ts";
import { isBunShellScriptMetadataFailure } from "./bun-sh-metadata.ts";
export { parseScriptFile, inspectScriptContent } from "./bun-sh-inspection.ts";

export { bunShellFrontMatterCoordinates } from "./bun-sh-frontmatter.ts";

export const SCRIPTS_DIRNAME = join(".lando", "scripts");

export interface DiscoveredBunShellScript {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly service: string;
  readonly summary: string;
  readonly frontMatter: BunShellScriptFrontMatter;
}

export type BunShellScriptDiscoveryError =
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | NotImplementedError;

export interface BunShellScriptProblem extends Omit<BunShellFrontMatterProblem, "error"> {
  readonly error: BunShellScriptDiscoveryError;
  readonly duplicate?: true;
  readonly io?: true;
  readonly id?: string;
}

export interface BunShellScriptInspection {
  readonly scripts: readonly DiscoveredBunShellScript[];
  readonly problems: readonly BunShellScriptProblem[];
  readonly files: readonly { readonly relativePath: string; readonly contentDigest: string }[];
}

interface WalkEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
}

const walkScriptsDir = async (root: string): Promise<ReadonlyArray<WalkEntry>> => {
  const found: WalkEntry[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) continue;
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      found.push({ absolutePath, relativePath });
    }
  };
  await visit(root);
  return found;
};

const scriptsDirExists = async (scriptsDir: string): Promise<boolean> => {
  const s = await stat(scriptsDir).catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  });
  return s?.isDirectory() === true;
};

export interface DiscoverBunShellScriptsOptions {
  readonly appRoot: string;
  /** Listing may omit content failures; I/O failures still fail discovery. */
  readonly skipInvalid?: boolean;
}

export const bunShellScriptPaths = (appRoot: string) => {
  const scriptsDir = join(appRoot, SCRIPTS_DIRNAME);
  return Effect.tryPromise({
    try: async () => ((await scriptsDirExists(scriptsDir)) ? walkScriptsDir(scriptsDir) : []),
    catch: (cause) =>
      new BunShellScriptFrontMatterError({
        message: `Failed to read .lando/scripts directory at ${scriptsDir}: ${causeMessage(cause)}`,
        path: scriptsDir,
        remediation: "Ensure the directory is readable by the current user.",
        cause,
      }),
  });
};

export const scriptCollisionError = (id: string, paths: readonly string[]) =>
  new BunShellScriptFrontMatterError({
    message: `.bun.sh scripts at ${paths.join(" and ")} resolve to the same canonical id ${id}.`,
    path: paths[0] ?? "<scripts>",
    remediation: "Rename one of the conflicting scripts so each canonical id (app:<segments>) is unique.",
  });

export const inspectBunShellScripts = Effect.fn("Landofile.inspectBunShellScripts")(function* (options: {
  readonly appRoot: string;
}): Effect.fn.Return<BunShellScriptInspection> {
  const scriptsDir = join(options.appRoot, SCRIPTS_DIRNAME);
  const entries = yield* bunShellScriptPaths(options.appRoot).pipe(Effect.result);
  if (Result.isFailure(entries)) {
    const error = entries.failure;
    return {
      scripts: [],
      files: [],
      problems: [
        {
          file: scriptsDir,
          path: [],
          message: error.message,
          suggestion: error.remediation,
          error,
          io: true,
        },
      ],
    };
  }

  const groups = Map.groupBy(
    entries.success,
    (entry) => canonicalIdFromRelativePath(entry.relativePath)?.id ?? entry.relativePath,
  );
  const out: DiscoveredBunShellScript[] = [];
  const problems: BunShellScriptProblem[] = [];
  const files: { relativePath: string; contentDigest: string }[] = [];
  for (const [id, group] of groups) {
    if (group.length > 1) {
      const error = scriptCollisionError(
        id,
        group.map((entry) => entry.absolutePath),
      );
      problems.push({
        file: error.path,
        path: [],
        message: error.message,
        suggestion: error.remediation,
        error,
        duplicate: true,
        id,
      });
    }
    for (const entry of group) {
      const read = yield* readScriptContent(entry.absolutePath).pipe(Effect.result);
      if (Result.isFailure(read)) {
        const error = read.failure;
        problems.push({
          file: entry.absolutePath,
          path: [],
          message: error.message,
          suggestion: error.remediation,
          error,
          io: true,
        });
        continue;
      }
      files.push({
        relativePath: entry.relativePath,
        contentDigest: sha256Hex(read.success),
      });
      if (group.length > 1) continue;
      const parsed = yield* inspectScriptContent(entry.absolutePath, entry.relativePath, read.success);
      const canonical = canonicalIdFromRelativePath(entry.relativePath);
      problems.push(
        ...parsed.problems.map((problem) => ({
          ...problem,
          ...(canonical === null ? {} : { id: canonical.id }),
        })),
      );
      if (parsed.script !== undefined) {
        const serviceProblem = scriptServiceProblem(parsed.script, read.success);
        if (serviceProblem === undefined) out.push(parsed.script);
        else problems.push(serviceProblem);
      }
    }
  }

  return {
    scripts: out.sort((a, b) => a.id.localeCompare(b.id)),
    problems,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
});

export const discoverBunShellScripts = Effect.fn("Landofile.discoverBunShellScripts")(function* (
  options: DiscoverBunShellScriptsOptions,
): Effect.fn.Return<ReadonlyArray<DiscoveredBunShellScript>, BunShellScriptDiscoveryError> {
  const inspected = yield* inspectBunShellScripts(options);
  const failure = inspected.problems.find(
    (problem) =>
      problem.io === true ||
      problem.duplicate === true ||
      options.skipInvalid !== true ||
      !isBunShellScriptMetadataFailure(problem.error),
  );
  if (failure !== undefined) return yield* Effect.fail(failure.error);
  return inspected.scripts;
});
