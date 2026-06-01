import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Effect } from "effect";

import { RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { ConfigServiceLive } from "../services/config.ts";
import type { ResolvedRecipe } from "./source.ts";

export interface GitRecipeCloneInput {
  readonly url: string;
  readonly stagingDir: string;
  readonly dest: string;
}

export interface GitRecipeCloneResult {
  readonly commitSha: string;
}

export interface GitRecipeCloner {
  readonly clone: (input: GitRecipeCloneInput) => Promise<GitRecipeCloneResult>;
}

export interface ResolveGitRecipeSourceOptions {
  readonly url: string;
  readonly path?: string;
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  readonly cloner?: GitRecipeCloner;
}

export interface ResolvedGitRecipe extends ResolvedRecipe {
  readonly commitSha: string;
}

const gitEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
} as const;

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

const runGit = async (args: ReadonlyArray<string>, cwd?: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, ...gitEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, text(proc.stdout), text(proc.stderr)]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() === "" ? `git ${args.join(" ")} failed with exit code ${exitCode}` : stderr.trim(),
    );
  }
  return stdout.trim();
};

export const defaultGitRecipeCloner: GitRecipeCloner = {
  clone: async ({ url, stagingDir }) => {
    await runGit(["clone", "--depth", "1", "--", url, stagingDir]);
    return { commitSha: await runGit(["rev-parse", "HEAD"], stagingDir) };
  },
};

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const authFailure = (cause: unknown): boolean =>
  /auth|credential|permission denied|publickey|could not read username|terminal prompts disabled/i.test(
    causeMessage(cause),
  );

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: "clone-failed" | "auth" | "subpath-missing" | "subpath-invalid" | "cache";
  readonly remediation: string;
}): RecipeSourceError => new RecipeSourceError(input);

const normalizeSubpath = (subpath: string | undefined): string | undefined => {
  if (subpath === undefined || subpath.trim() === "" || subpath === ".") return undefined;
  const slashPath = subpath.replace(/\\/gu, "/");
  if (isAbsolute(subpath) || slashPath.startsWith("/")) {
    throw sourceError({
      message: `Git recipe --path must be relative and stay inside the cloned repository: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: "Pass a relative path inside the repository, such as --path=packages/foo.",
    });
  }
  const normalized = relative(".", resolve(".", slashPath));
  if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw sourceError({
      message: `Git recipe --path escapes the cloned repository: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: "Pass a relative path inside the repository, such as --path=packages/foo.",
    });
  }
  return normalized;
};

const userDataRoot = async (override: string | undefined): Promise<string> => {
  if (override !== undefined) return override;
  const resolved = await Effect.runPromise(
    Effect.flatMap(ConfigService, (config) => config.get("userDataRoot")).pipe(
      Effect.provide(ConfigServiceLive),
    ),
  );
  if (resolved === undefined) throw new Error("ConfigService returned no userDataRoot.");
  return resolved;
};

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const publish = async (stagingDir: string, publishedDir: string): Promise<void> => {
  try {
    await rename(stagingDir, publishedDir);
  } catch (cause) {
    if (await fileExists(publishedDir)) {
      await rm(stagingDir, { recursive: true, force: true });
      return;
    }
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EXDEV") {
      await cp(stagingDir, publishedDir, { recursive: true, errorOnExist: true, force: false });
      await rm(stagingDir, { recursive: true, force: true });
      return;
    }
    throw cause;
  }
};

export const resolveGitRecipeSource = async (
  options: ResolveGitRecipeSourceOptions,
): Promise<ResolvedGitRecipe> => {
  const safeSubpath = normalizeSubpath(options.path);
  const root = await userDataRoot(options.userDataRoot).catch((cause) => {
    throw sourceError({
      message: `Could not resolve the Lando user data root for git recipe caching: ${causeMessage(cause)}`,
      source: "git",
      kind: "cache",
      remediation: "Set LANDO_USER_DATA_ROOT or fix the Lando config file, then retry lando init.",
    });
  });
  const cacheRoot = join(root, "recipe-cache", "git");
  await mkdir(cacheRoot, { recursive: true }).catch((cause) => {
    throw sourceError({
      message: `Could not create git recipe cache at ${cacheRoot}: ${causeMessage(cause)}`,
      source: options.url,
      kind: "cache",
      remediation: "Check permissions for the Lando user data root and retry lando init.",
    });
  });

  const stagingDir = await mkdtemp(join(cacheRoot, ".staging-"));
  let commitSha: string;
  try {
    commitSha = (
      await (options.cloner ?? options.gitRecipeCloner ?? defaultGitRecipeCloner).clone({
        url: options.url,
        dest: stagingDir,
        stagingDir,
      })
    ).commitSha.trim();
  } catch (cause) {
    await rm(stagingDir, { recursive: true, force: true });
    throw sourceError({
      message: `Could not clone git recipe source ${options.url}: ${causeMessage(cause)}`,
      source: options.url,
      kind: authFailure(cause) ? "auth" : "clone-failed",
      remediation: authFailure(cause)
        ? "Check git credentials or use a public URL; Lando disables interactive git credential prompts during init."
        : "Check that the git URL is reachable and retry lando init.",
    });
  }

  const publishedDir = join(cacheRoot, commitSha);
  if (await fileExists(publishedDir)) {
    await rm(stagingDir, { recursive: true, force: true });
  } else {
    await publish(stagingDir, publishedDir).catch(async (cause) => {
      await rm(stagingDir, { recursive: true, force: true });
      throw sourceError({
        message: `Could not publish git recipe cache at ${publishedDir}: ${causeMessage(cause)}`,
        source: options.url,
        kind: "cache",
        remediation: "Check permissions for the Lando user data root and retry lando init.",
      });
    });
  }

  const recipeRoot = safeSubpath === undefined ? publishedDir : join(publishedDir, safeSubpath);
  const manifestPath = join(recipeRoot, "recipe.yml");
  if (!(await fileExists(manifestPath))) {
    if (safeSubpath !== undefined) {
      throw sourceError({
        message: `recipe.yml not found at git recipe subpath ${safeSubpath}.`,
        source: options.url,
        kind: "subpath-missing",
        remediation: "Choose a --path that contains recipe.yml at its top level.",
      });
    }
    throw new RecipeManifestNotFoundError({
      message: `recipe.yml not found at ${manifestPath}.`,
      source: manifestPath,
    });
  }

  // Intentional: git recipes cache under the user DATA root (not the cache root other caches use), keyed by resolved commit SHA.
  return {
    id: options.url,
    source: manifestPath,
    manifestYaml: await Bun.file(manifestPath).text(),
    root: recipeRoot,
    commitSha,
  };
};
