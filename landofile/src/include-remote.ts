import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RecipeSourceError, causeMessage } from "@lando/sdk/errors";
import {
  type FragmentResult,
  NO_NETWORK_REMEDIATION,
  type NormalizedInclude,
  type ResolveContext,
  requiredPorts,
} from "./include-context.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";
import { fileExists, readText } from "./include-local.ts";
import { parseGitInclude, parseNpmInclude } from "./include-source.ts";
import type { NpmRecipeSourcePort } from "./ports.ts";

const fetchLockedFragmentFromCache = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
  layout: {
    readonly sourceId: string;
    readonly cacheKind: "git" | "npm";
    readonly publishedDirName: (resolved: string) => string;
    readonly fragmentRelPath: string;
    readonly publishedRootLabel: "cloned repository" | "npm package";
  },
): Promise<FragmentResult> => {
  const locked = ctx.lockEntries.get(layout.sourceId);
  if (locked === undefined)
    throw includeError({
      message: `--no-network: no lockfile entry for ${entry.source} to resolve from cache.`,
      source: entry.source,
      kind: "source-unresolved",
      remediation: NO_NETWORK_REMEDIATION,
    });
  const cacheRoot = join(ctx.cacheRoot, "includes", layout.cacheKind);
  const publishedDir = await assertUnderRoot(
    cacheRoot,
    join(cacheRoot, layout.publishedDirName(locked.resolved)),
    entry.source,
    "include cache",
  );
  const filePath = join(publishedDir, layout.fragmentRelPath);
  if (!(await fileExists(filePath)))
    throw includeError({
      message: `--no-network: cached fragment for ${entry.source} is missing at ${filePath}.`,
      source: entry.source,
      kind: "fetch-failed",
      remediation: NO_NETWORK_REMEDIATION,
    });
  const safePath = await assertUnderRoot(publishedDir, filePath, entry.source, layout.publishedRootLabel);
  return {
    sourceId: layout.sourceId,
    inventoryId: layout.sourceId,
    authoredSource: entry.source,
    resolved: locked.resolved,
    content: await readText(safePath, entry.source),
    filePath: safePath,
    root: dirname(safePath),
    userOwned: false,
    locked: true,
  };
};
export const fetchGit = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const parsed = parseGitInclude(entry);
  if (ctx.noNetwork)
    return fetchLockedFragmentFromCache(entry, ctx, {
      sourceId: parsed.sourceId,
      cacheKind: "git",
      publishedDirName: (resolved) => resolved,
      fragmentRelPath: parsed.path,
      publishedRootLabel: "cloned repository",
    });
  const gitRoot = join(ctx.cacheRoot, "includes", "git");
  await mkdir(gitRoot, { recursive: true });
  const stagingDir = await mkdtemp(join(gitRoot, ".staging-"));
  let commitSha: string;
  try {
    commitSha = (
      await (ctx.deps.gitCloner ?? requiredPorts(ctx).git).clone({
        url: parsed.cloneUrl,
        stagingDir,
        dest: stagingDir,
      })
    ).commitSha.trim();
  } catch (cause) {
    await rm(stagingDir, { recursive: true, force: true });
    throw includeError({
      message: `Could not clone include ${entry.source}: ${causeMessage(cause)}`,
      source: entry.source,
      kind: "fetch-failed",
    });
  }
  const publishedDir = join(gitRoot, commitSha);
  if (await fileExists(publishedDir)) await rm(stagingDir, { recursive: true, force: true });
  else await (ctx.deps.publication ?? requiredPorts(ctx).publication).publish(stagingDir, publishedDir);
  const filePath = await assertUnderRoot(
    publishedDir,
    join(publishedDir, parsed.path),
    entry.source,
    "cloned repository",
  );
  return {
    sourceId: parsed.sourceId,
    inventoryId: parsed.sourceId,
    authoredSource: entry.source,
    resolved: commitSha,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    userOwned: false,
    locked: true,
  };
};
export const fetchNpm = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const parsed = parseNpmInclude(entry);
  if (ctx.noNetwork)
    return fetchLockedFragmentFromCache(entry, ctx, {
      sourceId: parsed.sourceId,
      cacheKind: "npm",
      publishedDirName: (resolved) => `${parsed.packageName.replace(/[^A-Za-z0-9._-]+/gu, "-")}-${resolved}`,
      fragmentRelPath: join("package", parsed.path),
      publishedRootLabel: "npm package",
    });
  let resolvedPackage: Awaited<ReturnType<NpmRecipeSourcePort["resolve"]>>;
  try {
    resolvedPackage = await (ctx.deps.npmRecipeSource ?? requiredPorts(ctx).npmRecipeSource).resolve(
      parsed.packageSpec,
    );
  } catch (cause) {
    throw includeError({
      message: `Could not resolve npm include package ${parsed.packageSpec}: ${causeMessage(cause)}`,
      source: entry.source,
      kind:
        cause instanceof RecipeSourceError && cause.kind !== "registry-failed"
          ? "source-unresolved"
          : "fetch-failed",
    });
  }
  const { version, dist } = resolvedPackage;
  const tarball = dist.tarball;
  let archive: Uint8Array;
  try {
    archive = await (ctx.deps.npmFetcher ?? requiredPorts(ctx).tarball).fetch(tarball);
  } catch (cause) {
    throw includeError({
      message: `Could not download npm include ${tarball}: ${causeMessage(cause)}`,
      source: entry.source,
      kind: "fetch-failed",
    });
  }
  const npmRoot = join(ctx.cacheRoot, "includes", "npm");
  await mkdir(npmRoot, { recursive: true });
  const publishedDir = join(npmRoot, `${parsed.packageName.replace(/[^A-Za-z0-9._-]+/gu, "-")}-${version}`);
  if (!(await fileExists(publishedDir))) {
    const stagingDir = await mkdtemp(join(npmRoot, ".staging-"));
    try {
      await (ctx.deps.npmExtractor ?? requiredPorts(ctx).tarball).extract(archive, stagingDir);
      await (ctx.deps.publication ?? requiredPorts(ctx).publication).publish(stagingDir, publishedDir);
    } catch (cause) {
      await rm(stagingDir, { recursive: true, force: true });
      throw includeError({
        message: `Could not extract npm include ${entry.source}: ${causeMessage(cause)}`,
        source: entry.source,
        kind: "fetch-failed",
      });
    }
  }
  const filePath = await assertUnderRoot(
    publishedDir,
    join(publishedDir, "package", parsed.path),
    entry.source,
    "npm package",
  );
  return {
    sourceId: parsed.sourceId,
    inventoryId: parsed.sourceId,
    authoredSource: entry.source,
    resolved: version,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    userOwned: false,
    locked: true,
  };
};
