import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FragmentResult, NormalizedInclude, ResolveContext } from "./include-context.ts";
import { assertUnderRoot, includeError, realpathOrSelf } from "./include-guard.ts";
import { fetchGit, fetchNpm } from "./include-remote.ts";

export const fetchRemoteRelative = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
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
  const remoteEntry = { source: origin.identity, path, version: origin.resolved };
  const fragment = await (origin.kind === "git" ? fetchGit(remoteEntry, ctx) : fetchNpm(remoteEntry, ctx));
  if (fragment !== undefined && fragment.resolved !== origin.resolved)
    throw includeError({
      message: `Remote child ${entry.source} did not resolve at parent revision ${origin.resolved}.`,
      source: entry.source,
      kind: "fetch-failed",
    });
  return fragment;
};
