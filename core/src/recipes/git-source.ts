import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLiteralGitRef } from "@lando/landofile/git-ref";
import { sha256Hex } from "@lando/sdk/digest";

import { RecipeSourceError, causeMessage, isErrnoCode } from "@lando/sdk/errors";

import type { ResolvedRecipe } from "./source";
import {
  normalizeRecipeSubpath,
  recipeFileExists,
  recipeUserDataRoot,
  resolveRecipeManifest,
} from "./source-support";

export interface GitRecipeCloneInput {
  readonly url: string;
  readonly ref?: string;
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
  readonly ref?: string;
  readonly onWarn?: (message: string) => void | Promise<void>;
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

const runGit = async (args: ReadonlyArray<string>, cwd?: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, ...gitEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() === "" ? `git ${args.join(" ")} failed with exit code ${exitCode}` : stderr.trim(),
    );
  }
  return stdout.trim();
};

export const defaultGitRecipeCloner: GitRecipeCloner = {
  clone: async ({ url, dest, ref }) => {
    await runGit(["init", "-q", dest]);
    await runGit(["-C", dest, "fetch", "-q", "--depth", "1", "--no-tags", "--", url, ref ?? "HEAD"]);
    await runGit([
      "-C",
      dest,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "checkout",
      "-q",
      "--detach",
      "FETCH_HEAD",
    ]);
    return { commitSha: await runGit(["-C", dest, "rev-parse", "HEAD"]) };
  },
};

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

interface PublishFileSystem {
  readonly rename: typeof rename;
  readonly cp: typeof cp;
  readonly rm: typeof rm;
  readonly fileExists: typeof recipeFileExists;
}

const publishFileSystem = { rename, cp, rm, fileExists: recipeFileExists } satisfies PublishFileSystem;

export const publish = async (
  stagingDir: string,
  publishedDir: string,
  fs: PublishFileSystem = publishFileSystem,
): Promise<void> => {
  try {
    await fs.rename(stagingDir, publishedDir);
  } catch (cause) {
    if (await fs.fileExists(publishedDir)) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      return;
    }
    if (isErrnoCode(cause, "EXDEV")) {
      try {
        await fs.cp(stagingDir, publishedDir, { recursive: true, errorOnExist: true, force: false });
      } catch (copyCause) {
        if (await fs.fileExists(publishedDir)) {
          await fs.rm(stagingDir, { recursive: true, force: true });
          return;
        }
        throw copyCause;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
      return;
    }
    throw cause;
  }
};

export const resolveGitRecipeSource = async (
  options: ResolveGitRecipeSourceOptions,
): Promise<ResolvedGitRecipe> => {
  if (options.ref !== undefined && !isLiteralGitRef(options.ref)) {
    throw sourceError({
      message: `Invalid git recipe ref: ${options.ref}`,
      source: options.url,
      kind: "clone-failed",
      remediation: "Choose a literal tag, branch, or full commit SHA.",
    });
  }
  const safeSubpath = normalizeRecipeSubpath(
    options.path,
    { label: "Git", container: "cloned repository", noun: "repository" },
    (input) => {
      throw sourceError(input);
    },
  );
  const root = await recipeUserDataRoot(options.userDataRoot).catch((cause) => {
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

  const pointer = join(cacheRoot, ".url", sha256Hex(`${options.url}#${options.ref ?? "HEAD"}`));
  const cachedSha = (await recipeFileExists(pointer)) ? (await Bun.file(pointer).text()).trim() : "";
  const cachedCommit =
    /^[0-9a-f]{40}$/u.test(cachedSha) && (await recipeFileExists(join(cacheRoot, cachedSha)))
      ? cachedSha
      : undefined;
  const pinnedSha = /^[0-9a-f]{40}$/iu.test(options.ref ?? "") ? options.ref?.toLowerCase() : undefined;
  let commitSha =
    pinnedSha !== undefined && (await recipeFileExists(join(cacheRoot, pinnedSha))) ? pinnedSha : undefined;
  if (commitSha === undefined) {
    const stagingDir = await mkdtemp(join(cacheRoot, ".staging-"));
    try {
      commitSha = (
        await (options.cloner ?? options.gitRecipeCloner ?? defaultGitRecipeCloner).clone({
          url: options.url,
          ...(options.ref === undefined ? {} : { ref: options.ref }),
          dest: stagingDir,
          stagingDir,
        })
      ).commitSha;
    } catch (cause) {
      await rm(stagingDir, { recursive: true, force: true });
      const isAuth = authFailure(cause) || (cause instanceof RecipeSourceError && cause.kind === "auth");
      if (!isAuth && cachedCommit !== undefined && options.onWarn !== undefined) {
        commitSha = cachedCommit;
        await options.onWarn(
          `Could not refresh git recipe ${options.url}@${options.ref ?? "HEAD"}; using cached commit ${cachedCommit}.`,
        );
      } else {
        throw sourceError({
          message: `Could not clone git recipe source ${options.url}: ${causeMessage(cause)}`,
          source: options.url,
          kind: isAuth ? "auth" : "clone-failed",
          remediation: isAuth
            ? "Check git credentials or use a public URL; Lando disables interactive git credential prompts during init."
            : "Check that the git URL is reachable and retry lando init.",
        });
      }
    }

    if (!/^[0-9a-f]{40}$/u.test(commitSha) || (pinnedSha !== undefined && commitSha !== pinnedSha)) {
      await rm(stagingDir, { recursive: true, force: true });
      throw sourceError({
        message: `Git recipe acquisition returned commit ${commitSha}, not a full SHA${pinnedSha === undefined ? "" : ` matching ${pinnedSha}`}.`,
        source: options.url,
        kind: "clone-failed",
        remediation: "Use a git cloner that returns a full 40-character lowercase commit SHA.",
      });
    }

    const publishedDir = join(cacheRoot, commitSha);
    if (await recipeFileExists(publishedDir)) {
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
    await mkdir(join(cacheRoot, ".url"), { recursive: true });
    await writeFile(pointer, commitSha);
  }

  const publishedDir = join(cacheRoot, commitSha);

  const { recipeRoot, manifestPath, manifestYaml } = await resolveRecipeManifest({
    publishedDir,
    safeSubpath,
    sourceKind: "git",
    source: options.url,
    fail: (input) => {
      throw sourceError(input);
    },
  });

  // Git recipes cache under the user data root (not the cache root), keyed by commit SHA.
  return {
    id: options.url,
    source: manifestPath,
    manifestYaml,
    root: recipeRoot,
    commitSha,
  };
};
