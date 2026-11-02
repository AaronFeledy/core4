import { sha256Hex } from "@lando/sdk/digest";
import { LandofileLoadFailure } from "@lando/sdk/errors";
import { isMergeDirective, override } from "@lando/sdk/landofile";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect, Schema } from "effect";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { hasIncludeConditions } from "./include-condition-shape.ts";
import { reserveConditionalSelectors } from "./include-conditional-selectors.ts";
import { materializeIncludeConditions } from "./include-conditions.ts";
import type { ResolveContext, ResolveIncludesError } from "./include-context.ts";
import { ownVersionConstraintEntries, withoutIncludeArrays } from "./include-fragment.ts";
import { attributeIncludeError, includeError } from "./include-guard.ts";
import {
  getIncludeOverlays,
  includeAcquisitionView,
  rememberIncludeOverlays,
} from "./include-layer-overlays.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import { acquireIncludeRequest } from "./include-request.ts";
import { authoredIncludeEntriesWithPaths } from "./include-source.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import { loadPathBlocked } from "./load-failures.ts";
import { buildLandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import { getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
import {
  assertCompatibleIncludeFields,
  composeToolingIncludeEntries,
  resolveToolingIncludeSourceRoots,
} from "./tooling-include-entries.ts";
import { validationErrorFromCause } from "./validation.ts";
import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "./version-constraint.ts";

export const resolveTree = Effect.fnUntraced(function* (
  landofile: Record<string, unknown>,
  ctx: ResolveContext,
  traversal: {
    readonly depth: number;
    readonly stack: ReadonlyArray<string>;
    readonly source: string;
    readonly layer: VersionConstraintEntry["layer"];
    readonly order: VersionConstraintEntry["order"];
  },
): Effect.fn.Return<Record<string, unknown>, ResolveIncludesError> {
  const { depth, stack, source, layer, order } = traversal;
  if (depth > ctx.maxDepth)
    return yield* Effect.fail(
      includeError({
        message: `Landofile includes exceed the maximum depth of ${ctx.maxDepth}.`,
        source: stack.at(-1) ?? "includes",
        kind: "max-depth",
      }),
    );
  const file = getSourceDocuments(landofile)[0]?.file ?? source;
  if (hasIncludeConditions(landofile))
    yield* reserveConditionalSelectors(landofile, ctx, { file, layer, path: [] });
  const conditioned = yield* materializeIncludeConditions(landofile, {
    source: { sourcePath: file, sourceRoot: ctx.sourceRoot, appRoot: ctx.appRoot, layer },
    policy: ctx.userOwned ? { ...ctx.loadPolicy, allowFileAccess: false } : ctx.loadPolicy,
    scope: {
      ...(ctx.loadScope ??
        (yield* buildLandofileLoadScope([{ file, value: landofile }], undefined, ctx.pendingSites))),
      recorder: ctx.recorder,
      includeMode: ctx.mode === "pin" ? "conditional" : "all",
    },
    ...(ctx.onRelaxedRead === undefined ? {} : { onRelaxedRead: ctx.onRelaxedRead }),
  });
  let sourced = copyLandofileProvenance(
    conditioned,
    rememberLandofileReferencedFiles(
      resolveToolingIncludeSourceRoots(conditioned, ctx.sourceRoot, ctx.appRoot),
      getLandofileReferencedFiles(conditioned),
    ),
  );
  if (ctx.loadScope !== undefined) {
    const materialized = yield* materializeLandofileLayer(source, sourced, {
      ...ctx.loadScope,
      recorder: ctx.recorder,
      pendingSites: ctx.pendingSites ?? ctx.loadScope.pendingSites ?? [],
      siteFilter: (site) => site.path[0] === "includes" || site.path[0] === "include",
    });
    if (isPlainRecord(materialized)) sourced = materialized;
  }
  if (ctx.recorder !== undefined)
    sourced = prepareIncludeAcquisition(sourced, {
      recorder: ctx.recorder,
      source: { file: source, layer, path: [] },
    });
  const acquisition = yield* Effect.try({
    try: () => includeAcquisitionView(sourced),
    catch: (cause) => validationErrorFromCause(source, sourced, cause),
  });
  if (ctx.recorder !== undefined && ctx.recorder.failures.length > 0) ctx.walk.complete = false;
  const incompatible = assertCompatibleIncludeFields(acquisition);
  if (incompatible !== undefined)
    return yield* Effect.fail(
      attributeIncludeError(incompatible, { file: getSourceDocuments(sourced)[0]?.file ?? source, layer }),
    );
  const includes = authoredIncludeEntriesWithPaths(acquisition);
  if (includes.length === 0)
    return rememberIncludeOverlays(
      rememberLandofileIncludeSources(
        rememberLocalIncludePaths(
          rememberVersionConstraintEntries(
            copyLandofileProvenance(acquisition, { ...sourced }),
            ownVersionConstraintEntries(acquisition, source, layer, order),
          ),
          getLocalIncludePaths(landofile),
        ),
        getLandofileIncludeSources(landofile),
      ),
      [sourced],
    );
  const fragments: Record<string, unknown>[] = [];
  const fragmentRecords: Record<string, unknown>[] = [];
  const localIncludePaths: string[] = [...getLocalIncludePaths(landofile)];
  const includeSources = [...getLandofileIncludeSources(landofile)];
  for (const { entry: rawEntry, path } of includes) {
    const origin = { file: getSourceDocuments(sourced)[0]?.file ?? source, layer, path };
    if (loadPathBlocked(ctx.recorder, origin)) continue;
    yield* Effect.gen(function* () {
      const attributeError = (error: ResolveIncludesError): ResolveIncludesError =>
        attributeIncludeError(error, origin);
      const acquired = yield* acquireIncludeRequest(
        {
          entry: rawEntry,
          origin,
          source,
        },
        { ...ctx, ancestors: stack },
      );
      if (acquired === undefined) return;
      const { fragment, parsed } = acquired;
      const nested = yield* resolveTree(
        parsed,
        {
          ...ctx,
          ancestors: [...stack, fragment.sourceId],
          sourceRoot: fragment.root,
          userOwned: fragment.userOwned,
          remoteOrigin: fragment.remoteOrigin,
        },
        { depth: depth + 1, stack: [...stack, fragment.sourceId], source: fragment.sourceId, layer, order },
      ).pipe(Effect.mapError(attributeError));
      fragments.push(nested);
      fragmentRecords.push(...getIncludeOverlays(nested));
      localIncludePaths.push(...getLocalIncludePaths(nested));
      includeSources.push(...getLandofileIncludeSources(nested), {
        id: fragment.inventoryId,
        sha256: sha256Hex(fragment.content),
      });
      if (!fragment.locked) localIncludePaths.push(fragment.filePath);
    }).pipe(
      Effect.catch((error) => {
        if (ctx.recorder === undefined || !Schema.is(LandofileLoadFailure)(error)) return Effect.fail(error);
        ctx.recorder.record(error);
        ctx.walk.complete = false;
        return Effect.void;
      }),
    );
  }
  const toolingSources = [...fragmentRecords, sourced];
  const toolingEntries = composeToolingIncludeEntries(toolingSources);
  const toolingIncludes = toolingEntries.map((entry) => entry.value);
  const replacesTooling = toolingSources.some((value) => isMergeDirective(value.includes));
  const toolingOverlay = rememberOrigins(
    { includes: replacesTooling ? override(toolingIncludes) : toolingIncludes },
    {
      source: { file: source, layer, path: [] },
      deleted: false,
      children: new Map([
        [
          "includes",
          {
            source: { file: source, layer, path: ["includes"] },
            deleted: false,
            children: new Map(
              toolingEntries.flatMap((entry, index) =>
                entry.origins === undefined ? [] : [[index, entry.origins] as const],
              ),
            ),
          },
        ],
      ]),
    },
  );
  const overlays = [
    ...fragmentRecords.map(withoutIncludeArrays),
    withoutIncludeArrays(sourced),
    ...(replacesTooling || toolingIncludes.length > 0 ? [toolingOverlay] : []),
  ];
  const decoded = rememberSourceDocuments(
    { ...acquisition, ...(toolingIncludes.length === 0 ? {} : { includes: toolingIncludes }) },
    [...fragments.flatMap(getSourceDocuments), ...getSourceDocuments(sourced)],
  );
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
    overlays,
  );
});
