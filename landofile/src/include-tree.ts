import { sha256Hex } from "@lando/sdk/digest";
import { LandofileIncludeError, LandofileLockMismatchError, causeMessage } from "@lando/sdk/errors";
import { isMergeDirective, override } from "@lando/sdk/landofile";
import type { LandofileDecodedOverlay, LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { ResolveContext, ResolveIncludesError } from "./include-context.ts";
import { ownVersionConstraintEntries, parseFragment, withoutIncludeArrays } from "./include-fragment.ts";
import { hasIncludeCycle } from "./include-graph.ts";
import { includeError } from "./include-guard.ts";
import {
  getIncludeOverlays,
  includeAcquisitionView,
  rememberIncludeOverlays,
} from "./include-layer-overlays.ts";
import { fetchLocal, fetchUser } from "./include-local.ts";
import { stageFragmentLock } from "./include-lockfile.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import { fetchRemoteRelative } from "./include-remote-relative.ts";
import { fetchGit, fetchNpm } from "./include-remote.ts";
import { authoredIncludeEntries, classify, normalizeInclude } from "./include-source.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import {
  assertCompatibleIncludeFields,
  composeToolingIncludeEntries,
  resolveToolingIncludeSourceRoots,
} from "./tooling-include-entries.ts";
import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "./version-constraint.ts";

export const resolveTree = Effect.fnUntraced(function* (
  landofile: LandofileShape,
  ctx: ResolveContext,
  depth: number,
  stack: ReadonlyArray<string>,
  source: string,
  layer: VersionConstraintEntry["layer"],
  order: VersionConstraintEntry["order"],
): Effect.fn.Return<LandofileShape, ResolveIncludesError> {
  if (depth > ctx.maxDepth)
    return yield* Effect.fail(
      includeError({
        message: `Landofile includes exceed the maximum depth of ${ctx.maxDepth}.`,
        source: stack.at(-1) ?? "includes",
        kind: "max-depth",
      }),
    );
  const sourced = rememberLandofileReferencedFiles(
    resolveToolingIncludeSourceRoots(landofile, ctx.sourceRoot, ctx.appRoot),
    getLandofileReferencedFiles(landofile),
  );
  const acquisition = includeAcquisitionView(sourced);
  const incompatible = assertCompatibleIncludeFields(acquisition);
  if (incompatible !== undefined) return yield* Effect.fail(incompatible);
  const includes = authoredIncludeEntries(acquisition);
  if (includes.length === 0)
    return rememberIncludeOverlays(
      rememberLandofileIncludeSources(
        rememberLocalIncludePaths(
          rememberVersionConstraintEntries(
            acquisition,
            ownVersionConstraintEntries(acquisition, source, layer, order),
          ),
          getLocalIncludePaths(landofile),
        ),
        getLandofileIncludeSources(landofile),
      ),
      [sourced],
    );
  const fragments: LandofileShape[] = [];
  const fragmentRecords: Record<string, unknown>[] = [];
  const localIncludePaths: string[] = [...getLocalIncludePaths(landofile)];
  const includeSources = [...getLandofileIncludeSources(landofile)];
  for (const rawEntry of includes) {
    const entry = normalizeInclude(rawEntry);
    const fragment = yield* Effect.tryPromise({
      try: async () => {
        const kind = classify(entry.source);
        if (ctx.userOwned && (kind === "git" || kind === "npm"))
          throw includeError({
            message: `User Landofile profile ${source} must not declare remote include ${entry.source}.`,
            source: entry.source,
            kind: "source-unresolved",
            remediation: "Use relative or user: YAML includes inside the user includes directory.",
          });
        switch (kind) {
          case "local":
            return ctx.remoteOrigin === undefined ? fetchLocal(entry, ctx) : fetchRemoteRelative(entry, ctx);
          case "user":
            return fetchUser(entry, ctx);
          case "git":
            return fetchGit(entry, ctx);
          case "npm":
            return fetchNpm(entry, ctx);
        }
      },
      catch: (cause) =>
        cause instanceof LandofileIncludeError || cause instanceof LandofileLockMismatchError
          ? cause
          : includeError({ message: causeMessage(cause), source: entry.source, kind: "fetch-failed" }),
    });
    if (fragment === undefined) continue;
    yield* stageFragmentLock(fragment, ctx);
    if (hasIncludeCycle(stack, fragment.sourceId))
      return yield* Effect.fail(
        includeError({
          message: `Landofile include cycle detected at ${entry.source}.`,
          source: entry.source,
          kind: "cycle",
        }),
      );
    const parsed = yield* parseFragment(fragment, ctx, layer);
    const nested = yield* resolveTree(
      parsed as LandofileShape,
      {
        ...ctx,
        ancestors: [...stack, fragment.sourceId],
        sourceRoot: fragment.root,
        userOwned: fragment.userOwned,
        remoteOrigin: fragment.remoteOrigin,
      },
      depth + 1,
      [...stack, fragment.sourceId],
      fragment.sourceId,
      layer,
      order,
    );
    fragments.push(nested);
    fragmentRecords.push(...getIncludeOverlays(nested));
    localIncludePaths.push(...getLocalIncludePaths(nested));
    includeSources.push(...getLandofileIncludeSources(nested), {
      id: fragment.inventoryId,
      sha256: sha256Hex(fragment.content),
    });
    if (!fragment.locked) localIncludePaths.push(fragment.filePath);
  }
  const toolingSources = [...fragmentRecords, sourced];
  const toolingIncludes = composeToolingIncludeEntries(toolingSources);
  const replacesTooling = toolingSources.some((value) => isMergeDirective(value.includes));
  const overlays = [
    ...fragmentRecords.map(withoutIncludeArrays),
    withoutIncludeArrays(sourced),
    ...(replacesTooling
      ? [{ includes: override(toolingIncludes) }]
      : toolingIncludes.length === 0
        ? []
        : [{ includes: toolingIncludes }]),
  ];
  const decoded = { ...acquisition, ...(toolingIncludes.length === 0 ? {} : { includes: toolingIncludes }) };
  return rememberIncludeOverlays(
    rememberLandofileReferencedFiles(
      rememberLandofileIncludeSources(
        rememberLocalIncludePaths(
          rememberVersionConstraintEntries(decoded, [
            ...fragments.flatMap((fragment) => getVersionConstraintEntries(fragment, source)),
            ...ownVersionConstraintEntries(acquisition, source, layer, order),
          ]),
          [...localIncludePaths],
        ),
        includeSources,
      ),
      [...getLandofileReferencedFiles(sourced), ...fragments.flatMap(getLandofileReferencedFiles)],
    ),
    overlays as LandofileDecodedOverlay[],
  );
});
