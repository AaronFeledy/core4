import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPathWithin } from "@lando/paths";
import { LandofileIncludeError, RecipeSourceError, causeMessage } from "@lando/sdk/errors";
import {
  type FragmentResult,
  type NormalizedInclude,
  type ResolveContext,
  requiredPorts,
} from "./include-context.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";
import { fileExists, readText } from "./include-local.ts";
import { RESOLVED_FORMAT, readPinnedFragment } from "./include-pinned.ts";
import { parseGitInclude, parseNpmInclude } from "./include-source.ts";

const publishFragment = async (
  input: {
    readonly entry: NormalizedInclude;
    readonly sourceId: string;
    readonly version: string | undefined;
    readonly resolved: string;
    readonly stagingDir: string;
    readonly cacheRoot: string;
    readonly publishedDir: string;
    readonly path: string;
  },
  ctx: ResolveContext,
): Promise<FragmentResult> => {
  const { entry, sourceId, version, resolved, stagingDir, cacheRoot, path } = input;
  // publishedDir is joined from cacheRoot plus a revision-derived name; reject a
  // name that escapes before anything is removed or published there.
  const publishedDir = input.publishedDir;
  if (!isPathWithin(cacheRoot, publishedDir) || publishedDir === cacheRoot)
    throw includeError({
      message: `Include ${entry.source} resolves outside the include cache.`,
      source: entry.source,
      kind: "outside-root",
    });
  const stagedPath = await assertUnderRoot(stagingDir, join(stagingDir, path), entry.source, "remote source");
  const content = await readText(stagedPath, entry.source);
  const publishedPath = await assertUnderRoot(
    publishedDir,
    join(publishedDir, path),
    entry.source,
    "remote source",
  );
  if ((await fileExists(publishedPath)) && (await readText(publishedPath, entry.source)) === content) {
    await rm(stagingDir, { recursive: true, force: true });
  } else {
    await rm(publishedDir, { recursive: true, force: true });
    await (ctx.deps.publication ?? requiredPorts(ctx).publication).publish(stagingDir, publishedDir);
  }
  const filePath = join(publishedDir, path);
  return {
    sourceId,
    inventoryId: sourceId,
    authoredSource: entry.source,
    resolved,
    ...(version === undefined ? {} : { version }),
    content,
    filePath,
    root: dirname(filePath),
    userOwned: false,
    locked: true,
  };
};

export const fetchGit = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
): Promise<FragmentResult | undefined> => {
  const parsed = parseGitInclude(entry);
  return readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.ref,
    cacheKind: "git",
    publishedDirName: (resolved) => resolved,
    fragmentRelPath: parsed.path,
    acquire: async (resolved) => {
      const gitRoot = join(ctx.cacheRoot, "includes", "git");
      await mkdir(gitRoot, { recursive: true });
      const stagingDir = await mkdtemp(join(gitRoot, ".staging-"));
      const ref = resolved ?? parsed.ref;
      try {
        const commitSha = (
          await (ctx.deps.gitCloner ?? requiredPorts(ctx).git).clone({
            url: parsed.cloneUrl,
            stagingDir,
            dest: stagingDir,
            ...(ref === undefined ? {} : { ref }),
          })
        ).commitSha.trim();
        if (!RESOLVED_FORMAT.git.pattern.test(commitSha))
          throw includeError({
            message: `Git include ${entry.source} returned an invalid commit SHA: ${commitSha}.`,
            source: entry.source,
            kind: "fetch-failed",
          });
        return await publishFragment(
          {
            entry,
            sourceId: parsed.sourceId,
            version: parsed.ref,
            resolved: commitSha,
            stagingDir,
            cacheRoot: gitRoot,
            publishedDir: join(gitRoot, commitSha),
            path: parsed.path,
          },
          ctx,
        );
      } catch (cause) {
        await rm(stagingDir, { recursive: true, force: true });
        if (cause instanceof LandofileIncludeError) throw cause;
        throw includeError({
          message: `Could not fetch include ${entry.source} at ref ${ref ?? "HEAD"}: ${causeMessage(cause)}`,
          source: entry.source,
          kind: "fetch-failed",
        });
      }
    },
  });
};

export const fetchNpm = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
): Promise<FragmentResult | undefined> => {
  const parsed = parseNpmInclude(entry);
  const publishedDirName = (version: string) => `${parsed.packageName.replace("/", "+")}@${version}`;
  return readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.requestedVersion,
    cacheKind: "npm",
    publishedDirName,
    fragmentRelPath: join("package", parsed.path),
    acquire: async (resolved) => {
      const packageSpec = resolved === undefined ? parsed.packageSpec : `${parsed.packageName}@${resolved}`;
      const resolvedPackage = await (ctx.deps.npmRecipeSource ?? requiredPorts(ctx).npmRecipeSource)
        .resolve(packageSpec)
        .catch((cause: unknown) => {
          throw includeError({
            message: `Could not resolve npm include package ${packageSpec}: ${causeMessage(cause)}`,
            source: entry.source,
            kind:
              cause instanceof RecipeSourceError && cause.kind !== "registry-failed"
                ? "source-unresolved"
                : "fetch-failed",
          });
        });
      if (!RESOLVED_FORMAT.npm.pattern.test(resolvedPackage.version))
        throw includeError({
          message: `npm include ${entry.source} resolved to an invalid version: ${resolvedPackage.version}.`,
          source: entry.source,
          kind: "fetch-failed",
        });
      const npmRoot = join(ctx.cacheRoot, "includes", "npm");
      await mkdir(npmRoot, { recursive: true });
      const stagingDir = await mkdtemp(join(npmRoot, ".staging-"));
      try {
        const archive = await (ctx.deps.npmFetcher ?? requiredPorts(ctx).tarball).fetch(
          resolvedPackage.dist.tarball,
        );
        await (ctx.deps.npmExtractor ?? requiredPorts(ctx).tarball).extract(archive, stagingDir);
        return await publishFragment(
          {
            entry,
            sourceId: parsed.sourceId,
            version: parsed.requestedVersion,
            resolved: resolvedPackage.version,
            stagingDir,
            cacheRoot: npmRoot,
            publishedDir: join(npmRoot, publishedDirName(resolvedPackage.version)),
            path: join("package", parsed.path),
          },
          ctx,
        );
      } catch (cause) {
        await rm(stagingDir, { recursive: true, force: true });
        if (cause instanceof LandofileIncludeError) throw cause;
        throw includeError({
          message: `Could not acquire npm include ${entry.source}: ${causeMessage(cause)}`,
          source: entry.source,
          kind: "fetch-failed",
        });
      }
    },
  });
};
