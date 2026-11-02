import { isPlainRecord, mergeValuesWithOrigins, valueOriginAt, withValueOrigins } from "@lando/sdk/landofile";
import { AbsolutePath, LandofileShape, LoadScopedLandofile, type ParsedPendingSite } from "@lando/sdk/schema";
import type { Logger } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { captureCompilationContext, composedCarrier } from "../compilation.ts";
import { survivingSites } from "../compiled-sites.ts";
import { composeKeyRejectedError, firstComposeRejection } from "../compose/rejections.ts";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import { decodedPendingSites } from "../decoded-sites.ts";
import type { LandofileRelaxedRead } from "../include-context.ts";
import { includeAcquisitionView } from "../include-layer-overlays.ts";
import { getLocalIncludePaths, rememberLocalIncludePaths } from "../include-provenance.ts";
import { prepareIncludeAcquisition } from "../load-acquisition.ts";
import type { LandofileLoadPolicy } from "../load-expression-file.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "../load-expression-provenance.ts";
import { type LoadFailureRecorder, createLoadFailureRecorder, finishLoadStage } from "../load-failures.ts";
import { loadVersionConstraints } from "../load-version-constraints.ts";
import { applyToolingIncludeDefaults } from "../tooling-include-defaults.ts";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
  winningInternalToolingTasks,
} from "../tooling-include-provenance.ts";
import { resolveToolingIncludes } from "../tooling-includes.ts";
import { rejectUnsupportedToolingFeatures, scanToolingForUnsupported } from "../tooling-unsupported.ts";
import { validateLandofile, validationErrorFromCause } from "../validation.ts";
import { rememberVersionConstraintEntries } from "../version-constraint.ts";
import { type LandofileFinalizeOverrides, applyFinalizeOverrides } from "./finalize-overrides.ts";
import { finishClassifiedLoadStage } from "./load-stage.ts";
import {
  type LandofileLoadScope,
  buildLandofileLoadScope,
  materializeLandofileLayer,
} from "./materialize.ts";
import { getOrigins, rememberOrigins } from "./origins.ts";
import type { AuthoredOrigin } from "./prepare.ts";
import { type SourceDocument, getSourceDocuments, rememberSourceDocuments } from "./source-table.ts";

export const finalizeLandofile = Effect.fn("Landofile.finalize")(function* (
  file: string,
  authoredDocument: Record<string, unknown>,
  context: {
    readonly recorder?: LoadFailureRecorder | undefined;
    readonly appRoot: string;
    readonly rootDocuments?: readonly SourceDocument[];
    readonly overrides?: LandofileFinalizeOverrides | undefined;
    readonly pendingSites?: ParsedPendingSite[] | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly scope?: LandofileLoadScope;
    readonly loadPolicy?: LandofileLoadPolicy;
    readonly onRelaxedRead?: (read: LandofileRelaxedRead) => Effect.Effect<void>;
    readonly logger?: Context.Service.Shape<typeof Logger> | undefined;
  },
) {
  // Replacement origins on overridden keys make every origin-filtered site consumer drop the
  // displaced expressions; shadowed `lando:` sites stay in scope for constraint accumulation.
  const document = applyFinalizeOverrides(authoredDocument, context.overrides);
  const recorder = context.recorder ?? context.scope?.recorder ?? createLoadFailureRecorder();
  const scope = {
    ...(context.scope ??
      (yield* buildLandofileLoadScope([{ file, value: document }], context.env, context.pendingSites))),
    recorder,
  };
  const composed = yield* Effect.try({
    try: () =>
      composedCarrier({
        document,
        pendingSites: context.pendingSites ?? scope.pendingSites ?? [],
        context: captureCompilationContext(context.appRoot, scope.env),
      }),
    catch: (cause) => validationErrorFromCause(file, document, cause),
  }).pipe(
    Effect.catch((error) => {
      recorder.record(error);
      return Effect.succeed({ document });
    }),
  );
  const materialized = yield* materializeLandofileLayer(file, composed.document, {
    ...scope,
    siteFilter: (site) => site.path[0] !== "lando",
  });
  if (!isPlainRecord(materialized))
    return yield* Effect.fail(validationErrorFromCause(file, materialized, undefined));
  // A whole-map expression can introduce service ids after the authored map was filtered.
  const value =
    context.overrides?.excludedServices === undefined
      ? materialized
      : applyFinalizeOverrides(materialized, { excludedServices: context.overrides.excludedServices });
  const acquisitionDocument = prepareIncludeAcquisition(value, {
    recorder,
    source: { file, layer: "canonical", path: [] },
  });
  const acquisition = yield* Effect.try({
    try: () => includeAcquisitionView(acquisitionDocument),
    catch: (cause) => validationErrorFromCause(file, value, cause),
  }).pipe(
    Effect.catch((error) => {
      recorder.record(error);
      return Effect.succeed(includeAcquisitionView({}));
    }),
  );
  const origin: AuthoredOrigin = { file, layer: "canonical", path: [] };
  const ownOrigins = getOrigins(value) ?? withValueOrigins(value, (path) => ({ ...origin, path })).origins;
  const logger = context.logger;
  const onRelaxedRead =
    context.onRelaxedRead ??
    (logger === undefined
      ? undefined
      : (read: LandofileRelaxedRead) =>
          logger
            .info("Landofile load used outside-root policy override", {
              sourcePath: read.sourcePath,
              authoredPath: read.authoredPath,
              absolutePath: read.absolutePath,
              appRoot: read.appRoot,
            })
            .pipe(Effect.catch(() => Effect.void)));
  const tooling = yield* resolveToolingIncludes({
    recorder,
    landofile: acquisition,
    loadScope: scope,
    appRoot: context.appRoot,
    sourceRoot: context.appRoot,
    ...(context.loadPolicy === undefined ? {} : { loadPolicy: context.loadPolicy }),
    ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
    origins: getOrigins(acquisitionDocument) ?? ownOrigins,
  });
  rememberSourceDocuments(document, [...getSourceDocuments(document), ...tooling.sources]);
  rememberSourceDocuments(value, getSourceDocuments(document));
  const includedOrigins = withValueOrigins({ tooling: tooling.tooling }, (path) => ({
    ...origin,
    path,
  })).origins;
  const includedChildren = new Map(includedOrigins.children);
  const taskOrigins = getOrigins(tooling.tooling);
  if (taskOrigins !== undefined) includedChildren.set("tooling", taskOrigins);
  const merged = mergeValuesWithOrigins(
    LandofileShape,
    { value: { tooling: tooling.tooling }, origins: { ...includedOrigins, children: includedChildren } },
    { value: Object.hasOwn(value, "tooling") ? { tooling: value.tooling } : {}, origins: ownOrigins },
  );
  const tasks = isPlainRecord(merged.value) ? merged.value.tooling : undefined;
  const { include: _include, includes: _includes, toolingIncludes: _toolingIncludes, ...rest } = value;
  const assembled: Record<string, unknown> = copyLandofileProvenance(value, {
    ...rest,
    ...(isPlainRecord(tasks) && Object.keys(tasks).length > 0 ? { tooling: tasks } : {}),
  });
  const children = new Map(ownOrigins.children);
  const toolingOrigins = merged.origins.children.get("tooling");
  if (toolingOrigins !== undefined) children.set("tooling", toolingOrigins);
  rememberOrigins(assembled, { ...ownOrigins, children });
  rememberLandofileReferencedFiles(assembled, [
    ...getLandofileReferencedFiles(value),
    ...tooling.referencedFiles,
  ]);
  rememberLocalIncludePaths(assembled, [
    ...new Set([...getLocalIncludePaths(value), ...tooling.localFragmentPaths]),
  ]);
  rememberInternalToolingTasks(
    assembled,
    winningInternalToolingTasks([
      { tooling: tooling.tooling, internalTaskIds: tooling.internalTaskIds },
      {
        tooling: isPlainRecord(value.tooling) ? value.tooling : undefined,
        internalTaskIds: getInternalToolingTasks(value),
      },
    ]),
  );
  const effectiveOrigins = getOrigins(assembled) ?? ownOrigins;
  const constraints = yield* loadVersionConstraints(document, file, scope);
  for (const entry of constraints)
    if (valueOriginAt(ownOrigins, ["lando"]).source.file === entry.source) assembled.lando = entry.range;
  yield* context.rootDocuments === undefined
    ? finishLoadStage(file, recorder)
    : finishClassifiedLoadStage(file, recorder, {
        appRoot: context.appRoot,
        documents: context.rootDocuments,
      });
  yield* Effect.forEach(recorder.effectiveChecks, (check) => check);
  const unsupported = scanToolingForUnsupported(assembled);
  const unsupportedPath =
    unsupported === undefined
      ? []
      : unsupported.event === undefined
        ? [
            "tooling",
            unsupported.task,
            ...unsupported.key
              .replace(/\[(\d+)\]/g, ".$1")
              .split(".")
              .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
          ]
        : ["events", unsupported.event];
  yield* rejectUnsupportedToolingFeatures(
    valueOriginAt(effectiveOrigins, unsupportedPath).source.file,
    assembled,
  );
  const compose = firstComposeRejection(assembled);
  if (compose !== undefined) {
    const path = compose.documentPath
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    return yield* Effect.fail(
      composeKeyRejectedError({ source: valueOriginAt(effectiveOrigins, path).source.file, match: compose }),
    );
  }
  rememberVersionConstraintEntries(assembled, constraints);
  const validated = yield* validateLandofile(file, assembled);
  const defaults = applyToolingIncludeDefaults(validated, tooling.defaults, {
    included: tooling.tooling,
    authored: ownOrigins,
    effective: effectiveOrigins,
  });
  const decoded = defaults.document;
  const compiled = LoadScopedLandofile.make({
    stage: "load-scoped",
    document: decoded,
    pendingSites: [
      ...decodedPendingSites(assembled, decoded, survivingSites(effectiveOrigins, scope.pendingSites ?? [])),
      ...survivingSites(defaults.addedOrigins, scope.pendingSites ?? []),
    ],
    context: { appRoot: AbsolutePath.make(context.appRoot), env: scope.env },
  });
  rememberOrigins(assembled, defaults.origins);
  copyLandofileProvenance(assembled, compiled.document);
  return copyLandofileProvenance(assembled, compiled);
});
