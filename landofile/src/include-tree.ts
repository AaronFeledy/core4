import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileLoadFailure } from "@lando/sdk/errors";
import { type ValueWithOrigins, isMergeDirective, isPlainRecord, override } from "@lando/sdk/landofile";
import { Effect, Schema } from "effect";
import { hasIncludeConditions } from "./include-condition-shape.ts";
import { reserveConditionalSelectors } from "./include-conditional-selectors.ts";
import { materializeIncludeConditions } from "./include-conditions.ts";
import type { ResolveContext, ResolveIncludesError } from "./include-context.ts";
import { ownVersionConstraintEntries, withoutIncludeArrays } from "./include-fragment.ts";
import { attributeIncludeError, includeError } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { acquireIncludeRequest } from "./include-request.ts";
import { authoredIncludeEntriesWithPaths } from "./include-source.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import { loadPathBlocked } from "./load-failures.ts";
import { buildLandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import {
  type AuthoredDocument,
  type AuthoredOrigin,
  type LandofileProvenance,
  combineProvenance,
  normalizeIncludeSources,
  normalizeLocalIncludePaths,
} from "./provenance.ts";
import {
  assertCompatibleIncludeFields,
  composeToolingIncludeEntries,
  resolveToolingIncludeSourceRoots,
} from "./tooling-include-entries.ts";
import { validationErrorFromCause } from "./validation.ts";
import type { VersionConstraintEntry } from "./version-constraint.ts";

/** A resolved include tree: the effective document and the overlays that produced it. */
export interface ResolvedTree {
  readonly document: AuthoredDocument;
  readonly overlays: readonly ValueWithOrigins<AuthoredOrigin>[];
}

export const asOverlay = (document: AuthoredDocument): ValueWithOrigins<AuthoredOrigin> => ({
  value: document.value,
  origins: document.provenance.origins,
});

export const resolveTree: (
  document: AuthoredDocument,
  ctx: ResolveContext,
  traversal: {
    readonly depth: number;
    readonly stack: ReadonlyArray<string>;
    readonly source: string;
    readonly layer: VersionConstraintEntry["layer"];
    readonly order: VersionConstraintEntry["order"];
  },
) => Effect.Effect<ResolvedTree, ResolveIncludesError> = Effect.fnUntraced(
  function* (document, ctx, traversal) {
    const { depth, stack, source, layer, order } = traversal;
    if (depth > ctx.maxDepth)
      return yield* Effect.fail(
        includeError({
          message: `Landofile includes exceed the maximum depth of ${ctx.maxDepth}.`,
          source: stack.at(-1) ?? "includes",
          kind: "max-depth",
        }),
      );
    const file = document.provenance.documents[0]?.file ?? source;
    if (hasIncludeConditions(document.value))
      yield* reserveConditionalSelectors(document, ctx, { file, layer, path: [] });
    const conditioned = yield* materializeIncludeConditions(document, {
      source: { sourcePath: file, sourceRoot: ctx.sourceRoot, appRoot: ctx.appRoot, layer },
      policy: ctx.userOwned ? { ...ctx.loadPolicy, allowFileAccess: false } : ctx.loadPolicy,
      scope: {
        ...(ctx.loadScope ??
          (yield* buildLandofileLoadScope([{ file, value: document.value }], undefined, ctx.pendingSites))),
        recorder: ctx.recorder,
        includeMode: ctx.mode === "pin" ? "conditional" : "all",
      },
      ...(ctx.onRelaxedRead === undefined ? {} : { onRelaxedRead: ctx.onRelaxedRead }),
    });
    let sourced: AuthoredDocument = {
      value: resolveToolingIncludeSourceRoots(conditioned.value, ctx.sourceRoot, ctx.appRoot),
      provenance: conditioned.provenance,
    };
    if (ctx.loadScope !== undefined) {
      sourced = yield* materializeLandofileLayer(source, sourced, {
        ...ctx.loadScope,
        recorder: ctx.recorder,
        pendingSites: ctx.pendingSites ?? ctx.loadScope.pendingSites ?? [],
        siteFilter: (site) => site.path[0] === "includes" || site.path[0] === "include",
      });
    }
    if (ctx.recorder !== undefined)
      sourced = prepareIncludeAcquisition(sourced, {
        recorder: ctx.recorder,
        source: { file: source, layer, path: [] },
      });
    const acquisition = yield* Effect.try({
      try: () => includeAcquisitionView(sourced.value),
      catch: (cause) => validationErrorFromCause(source, sourced.value, cause, sourced.provenance),
    });
    if (ctx.recorder !== undefined && ctx.recorder.failures.length > 0) ctx.walk.complete = false;
    const incompatible = assertCompatibleIncludeFields(acquisition);
    if (incompatible !== undefined)
      return yield* Effect.fail(
        attributeIncludeError(incompatible, {
          file: sourced.provenance.documents[0]?.file ?? source,
          layer,
        }),
      );
    const includes = authoredIncludeEntriesWithPaths(acquisition, sourced.provenance);
    if (includes.length === 0)
      return {
        document: {
          value: { ...sourced.value },
          provenance: {
            ...sourced.provenance,
            versionConstraints: ownVersionConstraintEntries(sourced, source, layer, order),
          },
        },
        overlays: [asOverlay(sourced)],
      };
    const fragments: AuthoredDocument[] = [];
    const fragmentRecords: ValueWithOrigins<AuthoredOrigin>[] = [];
    const localIncludePaths: string[] = [...sourced.provenance.localIncludePaths];
    const includeSources = [...sourced.provenance.includeSources];
    for (const { entry: rawEntry, path } of includes) {
      const origin = { file: sourced.provenance.documents[0]?.file ?? source, layer, path };
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
        ).pipe(mapFailures(attributeError));
        fragments.push(nested.document);
        fragmentRecords.push(...nested.overlays);
        localIncludePaths.push(...nested.document.provenance.localIncludePaths);
        includeSources.push(...nested.document.provenance.includeSources, {
          id: fragment.inventoryId,
          sha256: sha256Hex(fragment.content),
        });
        if (!fragment.locked) localIncludePaths.push(fragment.filePath);
      }).pipe(
        Effect.catch((error) => {
          if (ctx.recorder === undefined || !Schema.is(LandofileLoadFailure)(error))
            return Effect.fail(error);
          ctx.recorder.record(error, { kind: "missing-content" });
          ctx.walk.complete = false;
          return Effect.void;
        }),
      );
    }
    const toolingSources = [...fragmentRecords, asOverlay(sourced)];
    const toolingEntries = composeToolingIncludeEntries(toolingSources);
    const toolingIncludes = toolingEntries.map((entry) => entry.value);
    const replacesTooling = toolingSources.some(
      (value) => isPlainRecord(value.value) && isMergeDirective(value.value.includes),
    );
    const toolingRoot: AuthoredOrigin = { file: source, layer, path: [] };
    const toolingOverlay: ValueWithOrigins<AuthoredOrigin> = {
      value: { includes: replacesTooling ? override(toolingIncludes) : toolingIncludes },
      origins: {
        source: toolingRoot,
        deleted: false,
        children: new Map([
          [
            "includes",
            {
              source: { ...toolingRoot, path: ["includes"] },
              deleted: false,
              children: new Map(toolingEntries.map((entry, index) => [index, entry.origins] as const)),
            },
          ],
        ]),
      },
    };
    const overlays: ValueWithOrigins<AuthoredOrigin>[] = [
      ...fragmentRecords,
      withoutIncludeArrays(sourced),
      ...(replacesTooling || toolingIncludes.length > 0 ? [toolingOverlay] : []),
    ];
    const provenance: LandofileProvenance = {
      ...combineProvenance(
        [...fragments.map((fragment) => fragment.provenance), sourced.provenance],
        sourced.provenance.origins,
      ),
      overlays,
      includeSources: normalizeIncludeSources(includeSources),
      localIncludePaths: normalizeLocalIncludePaths(localIncludePaths),
      versionConstraints: [
        ...fragments.flatMap((fragment) => fragment.provenance.versionConstraints),
        ...ownVersionConstraintEntries(sourced, source, layer, order),
      ],
    };
    const decoded: AuthoredDocument = {
      value: { ...acquisition, ...(toolingIncludes.length === 0 ? {} : { includes: toolingIncludes }) },
      provenance,
    };
    return { document: decoded, overlays };
  },
);
