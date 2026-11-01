import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isPathWithin } from "@lando/paths";
import { LandofileIncludeError, RecipeSourceError, causeMessage } from "@lando/sdk/errors";
import {
  type FragmentResult,
  type NormalizedInclude,
  type ResolveContext,
  requiredPorts,
} from "./include-context.ts";
import { assertUnderRoot, includeError, realpathOrSelf } from "./include-guard.ts";
import { fileExists, readText } from "./include-local.ts";
import { RESOLVED_FORMAT, type RemoteFragmentResult, readPinnedFragment } from "./include-pinned.ts";
import { parseGitInclude, parseNpmInclude } from "./include-source.ts";
import { checkNpmPackageDistIntegrity } from "./npm-integrity.ts";

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
    readonly snapshotSubdir: "" | "package";
  },
  ctx: ResolveContext,
): Promise<RemoteFragmentResult> => {
  const { entry, sourceId, version, resolved, stagingDir, cacheRoot, path } = input;
  // publishedDir is joined from cacheRoot plus a revision-derived name; reject a
  // name that escapes before anything is removed or published there.
  if (!isPathWithin(cacheRoot, input.publishedDir) || input.publishedDir === cacheRoot)
    throw includeError({
      message: `Include ${entry.source} resolves outside the include cache.`,
      source: entry.source,
      kind: "outside-root",
    });
  const canonicalRoot = await realpathOrSelf(cacheRoot);
  const publishedDir = await assertUnderRoot(
    canonicalRoot,
    join(canonicalRoot, basename(input.publishedDir)),
    entry.source,
    "include cache",
  );
  await assertUnderRoot(canonicalRoot, await realpathOrSelf(stagingDir), entry.source, "include cache");
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
    const aside = await assertUnderRoot(
      canonicalRoot,
      join(canonicalRoot, `.replaced-${crypto.randomUUID()}`),
      entry.source,
      "include cache",
    );
    const replacing = await fileExists(publishedDir);
    if (replacing) await rename(publishedDir, aside);
    await (ctx.deps.publication ?? requiredPorts(ctx).publication).publish(stagingDir, publishedDir);
    if (replacing) await rm(aside, { recursive: true, force: true });
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
    snapshotRoot: await assertUnderRoot(
      publishedDir,
      join(publishedDir, input.snapshotSubdir),
      entry.source,
      "remote source",
    ),
    userOwned: false,
    locked: true,
  };
};

export const fetchGit = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
): Promise<FragmentResult | undefined> => {
  const parsed = parseGitInclude(entry);
  const fragment = await readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.ref,
    cacheKind: "git",
    publishedDirName: (resolved) => resolved,
    fragmentRelPath: parsed.path,
    snapshotSubdir: "",
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
            snapshotSubdir: "",
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
  return fragment === undefined
    ? undefined
    : {
        ...fragment,
        remoteOrigin: {
          kind: "git",
          identity: parsed.sourceId.slice(0, -(parsed.path.length + 1)),
          acquisitionSource: parsed.cloneUrl,
          resolved: fragment.resolved ?? "",
          snapshotRoot: fragment.snapshotRoot,
          cacheRoot: join(ctx.cacheRoot, "includes", "git"),
        },
      };
};

export const fetchNpm = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
): Promise<FragmentResult | undefined> => {
  const parsed = parseNpmInclude(entry);
  const publishedDirName = (version: string) => `${parsed.packageName.replace("/", "+")}@${version}`;
  const fragment = await readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.requestedVersion,
    cacheKind: "npm",
    publishedDirName,
    fragmentRelPath: join("package", parsed.path),
    snapshotSubdir: "package",
    acquire: async (resolved) => {
      const packageSpec = resolved === undefined ? parsed.packageSpec : `${parsed.packageName}@${resolved}`;
      const npmSource = ctx.deps.npmRecipeSource ?? requiredPorts(ctx).npmRecipeSource;
      const resolvedPackage = await npmSource.resolve(packageSpec).catch((cause: unknown) => {
        throw includeError({
          message: `Could not resolve npm include package ${packageSpec}: ${causeMessage(cause)}`,
          ...(cause instanceof RecipeSourceError ? { remediation: cause.remediation } : {}),
          source: entry.source,
          kind:
            cause instanceof RecipeSourceError && cause.kind !== "registry-failed" && cause.kind !== "auth"
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
        const archive =
          ctx.deps.npmFetcher === undefined
            ? await npmSource.fetchTarball(resolvedPackage)
            : await ctx.deps.npmFetcher.fetch(resolvedPackage.dist.tarball);
        const integrity = checkNpmPackageDistIntegrity(archive, resolvedPackage.dist);
        switch (integrity.status) {
          case "verified":
            break;
          case "mismatch":
            throw includeError({
              message: `npm include ${entry.source} ${integrity.description}`,
              source: entry.source,
              kind: "fetch-failed",
              remediation: integrity.remediation,
            });
          case "unverifiable":
            throw includeError({
              message: `npm include ${entry.source}: the registry published no integrity hash or shasum.`,
              source: entry.source,
              kind: "fetch-failed",
              remediation: "Publish to a registry that reports dist.integrity or dist.shasum.",
            });
        }
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
            snapshotSubdir: "package",
          },
          ctx,
        );
      } catch (cause) {
        await rm(stagingDir, { recursive: true, force: true });
        if (cause instanceof LandofileIncludeError) throw cause;
        throw includeError({
          message: `Could not acquire npm include ${entry.source}: ${causeMessage(cause)}`,
          ...(cause instanceof RecipeSourceError ? { remediation: cause.remediation } : {}),
          source: entry.source,
          kind: "fetch-failed",
        });
      }
    },
  });
  return fragment === undefined
    ? undefined
    : {
        ...fragment,
        remoteOrigin: {
          kind: "npm",
          identity: `npm:${parsed.packageName}`,
          acquisitionSource: parsed.packageName,
          resolved: fragment.resolved ?? "",
          snapshotRoot: fragment.snapshotRoot,
          cacheRoot: join(ctx.cacheRoot, "includes", "npm"),
        },
      };
};
