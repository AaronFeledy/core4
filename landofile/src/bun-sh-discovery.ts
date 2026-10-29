import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Effect, Result } from "effect";

import {
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  type NotImplementedError,
  causeMessage,
  isErrnoCode,
} from "@lando/sdk/errors";
import type { BunShellScriptFrontMatter } from "@lando/sdk/schema";
import { FRONT_MATTER_REMEDIATION, parseBunShellScriptFrontMatter } from "./bun-sh-frontmatter.ts";
import { isBunShellScriptMetadataFailure, normalizeBunShellScript } from "./bun-sh-metadata.ts";

export const BUN_SHELL_SCRIPT_EXTENSION = ".bun.sh";
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

const sanitizeSegment = (segment: string): string => {
  const lowered = segment.toLowerCase();
  return lowered
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const canonicalIdFromRelativePath = (relativePath: string): { name: string; id: string } | null => {
  if (!relativePath.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) return null;
  const withoutExt = relativePath.slice(0, -BUN_SHELL_SCRIPT_EXTENSION.length);
  const segments = withoutExt
    .split(/[\\/]/)
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const name = segments.join(":");
  return { name, id: `app:${name}` };
};

export const parseScriptFile = Effect.fnUntraced(function* (
  scriptPath: string,
  relativePath: string,
): Effect.fn.Return<DiscoveredBunShellScript, BunShellScriptDiscoveryError> {
  const content = yield* Effect.tryPromise({
    try: () => readFile(scriptPath, "utf-8"),
    catch: (cause) =>
      new BunShellScriptFrontMatterError({
        message: `Failed to read .bun.sh script at ${scriptPath}: ${causeMessage(cause)}`,
        path: scriptPath,
        remediation: FRONT_MATTER_REMEDIATION,
        cause,
      }),
  });

  if (content.trim() === "") {
    return yield* Effect.fail(
      new BunShellScriptEmptyError({
        message: `.bun.sh script at ${scriptPath} is empty.`,
        path: scriptPath,
        remediation: "Add a `# ---` front-matter block and a script body, or delete the file.",
      }),
    );
  }

  const frontMatter = yield* parseBunShellScriptFrontMatter(scriptPath, content);
  const canonical = canonicalIdFromRelativePath(relativePath);
  if (canonical === null) {
    return yield* Effect.fail(
      new BunShellScriptFrontMatterError({
        message: `.bun.sh script at ${scriptPath} has no usable canonical name (relative path "${relativePath}").`,
        path: scriptPath,
        remediation:
          "Rename the file or directory so each path segment matches [a-z0-9_-]+ after lower-casing.",
      }),
    );
  }

  const script: DiscoveredBunShellScript = {
    id: canonical.id,
    name: canonical.name,
    path: scriptPath,
    relativePath,
    service: frontMatter.service ?? ":host",
    summary: frontMatter.description ?? frontMatter.desc ?? frontMatter.summary ?? "",
    frontMatter,
  };
  const normalized = normalizeBunShellScript(script);
  if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure);
  return script;
});

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
  /** Fingerprints skip a script that cannot be parsed. Command discovery still fails. */
  readonly skipInvalid?: boolean;
}

export const discoverBunShellScripts = Effect.fn("Landofile.discoverBunShellScripts")(function* (
  options: DiscoverBunShellScriptsOptions,
): Effect.fn.Return<ReadonlyArray<DiscoveredBunShellScript>, BunShellScriptDiscoveryError> {
  const scriptsDir = join(options.appRoot, SCRIPTS_DIRNAME);
  const entries = yield* Effect.tryPromise({
    try: async () => ((await scriptsDirExists(scriptsDir)) ? walkScriptsDir(scriptsDir) : []),
    catch: (cause) =>
      new BunShellScriptFrontMatterError({
        message: `Failed to read .lando/scripts directory at ${scriptsDir}: ${causeMessage(cause)}`,
        path: scriptsDir,
        remediation: "Ensure the directory is readable by the current user.",
        cause,
      }),
  });

  const seen = new Map<string, string>();
  const out: DiscoveredBunShellScript[] = [];
  for (const entry of entries) {
    const parsed = yield* Effect.result(parseScriptFile(entry.absolutePath, entry.relativePath));
    if (parsed._tag === "Failure") {
      if (options.skipInvalid === true && isBunShellScriptMetadataFailure(parsed.failure)) continue;
      return yield* Effect.fail(parsed.failure);
    }
    const script = parsed.success;
    const previous = seen.get(script.id);
    if (previous !== undefined) {
      return yield* Effect.fail(
        new BunShellScriptFrontMatterError({
          message: `.bun.sh scripts at ${previous} and ${entry.absolutePath} resolve to the same canonical id ${script.id}.`,
          path: entry.absolutePath,
          remediation:
            "Rename one of the conflicting scripts so each canonical id (app:<segments>) is unique.",
        }),
      );
    }
    seen.set(script.id, entry.absolutePath);
    out.push(script);
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
});
