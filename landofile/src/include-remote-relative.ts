import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FragmentResult, NormalizedInclude, ResolveContext } from "./include-context.ts";
import { assertUnderRoot, includeError, realpathOrSelf } from "./include-guard.ts";
import { readPinnedFragment } from "./include-pinned.ts";
import { requiredSourceSession, runSource } from "./include-sources.ts";

/**
 * Remote-relative children bind to the parent's physical snapshot key
 * and open it directly — never a second name@version lookup.
 */
export const fetchRemoteRelative = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<FragmentResult | undefined> => {
  const origin = ctx.remoteOrigin;
  if (origin === undefined)
    throw includeError({
      message: "Missing remote include origin.",
      source: entry.source,
      kind: "source-unresolved",
    });
  const authored = entry.source.replace(/\\/gu, "/");
  if (isAbsolute(authored) || /^[A-Za-z]:/u.test(authored))
    throw includeError({
      message: `Remote relative include must be relative: ${entry.source}`,
      source: entry.source,
      kind: "outside-root",
    });
  const root = await realpathOrSelf(origin.snapshotRoot);
  const declaringDir = await realpathOrSelf(ctx.sourceRoot);
  const child = await assertUnderRoot(root, resolve(declaringDir, authored), entry.source, "remote snapshot");
  const path = relative(root, child).split(sep).join("/");
  const sourceId = `${origin.identity}/${path}`;
  const session = await requiredSourceSession(ctx, signal);

  const fragment = await readPinnedFragment(
    { source: origin.identity, path, version: origin.resolved },
    ctx,
    {
      sourceId,
      version: origin.resolved,
      cacheKind: origin.kind,
      fragmentRelPath: path,
      openCached: async () =>
        origin.key.kind === "git"
          ? runSource(session.openGit(origin.key.commit), signal)
          : runSource(session.openArchive(origin.key.sha256), signal),
      acquire: async (_resolved, options) => {
        if (origin.key.kind === "git") {
          return runSource(
            session.materializeGit({
              url: origin.acquisitionSource,
              commit: origin.key.commit,
            }),
            signal,
          );
        }
        const opened = await runSource(session.openArchive(origin.key.sha256), signal);
        if (opened !== undefined) return opened;
        throw includeError({
          message: `Remote child ${entry.source} could not open parent snapshot ${origin.resolved}${options.repair ? " after refresh" : ""}.`,
          source: entry.source,
          kind: "fetch-failed",
        });
      },
    },
  );

  if (fragment !== undefined && fragment.resolved !== origin.resolved)
    throw includeError({
      message: `Remote child ${entry.source} did not resolve at parent revision ${origin.resolved}.`,
      source: entry.source,
      kind: "fetch-failed",
    });
  // Preserve the parent physical origin so nested relatives stay bound to the same snapshot.
  return fragment === undefined ? undefined : { ...fragment, remoteOrigin: origin };
};
