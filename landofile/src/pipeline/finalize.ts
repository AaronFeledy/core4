import { isPlainRecord, mergeValuesWithOrigins, valueOriginAt } from "@lando/sdk/landofile";
import { AbsolutePath, LandofileShape, LoadScopedLandofile, type ParsedPendingSite } from "@lando/sdk/schema";
import type { Logger } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";
import { captureCompilationContext, composedCarrier } from "../compilation.ts";
import { survivingSites } from "../compiled-sites.ts";
import { composeKeyRejectedError, firstComposeRejection } from "../compose/rejections.ts";
import { decodedPendingSites } from "../decoded-sites.ts";
import { unionEnvironmentDependencies } from "../environment-dependencies.ts";
import type { LandofileRelaxedRead } from "../include-context.ts";
import { ownVersionConstraintEntries } from "../include-fragment.ts";
import { includeAcquisitionView } from "../include-layer-overlays.ts";
import {
  type LandofileLintDiagnostic,
  type LoadUnavailableSite,
  diagnosticUnavailableSites,
} from "../lint-diagnostic.ts";
import { healthcheckDialectIssues } from "../lint-healthcheck.ts";
import { attributeLintIssue } from "../lint-source.ts";
import { prepareIncludeAcquisition } from "../load-acquisition.ts";
import type { LandofileLoadPolicy } from "../load-expression-file.ts";
import {
  type LoadFailureRecorder,
  type RecordedLoadFailure,
  createLoadFailureRecorder,
  finishLoadStage,
} from "../load-failures.ts";
import { loadVersionConstraints } from "../load-version-constraints.ts";
import {
  type AuthoredDocument,
  type LandofileProvenance,
  type SourceDocument,
  normalizeLocalIncludePaths,
  normalizeReferencedFiles,
} from "../provenance.ts";
import { hostReadinessPortSite, servicePortSiteError } from "../service-port-sites.ts";
import { applyToolingIncludeDefaults } from "../tooling-include-defaults.ts";
import { resolveToolingIncludes, winningInternalToolingTasks } from "../tooling-includes.ts";
import { rejectUnsupportedToolingFeatures, scanToolingForUnsupported } from "../tooling-unsupported.ts";
import { landofileValidationError, validateLandofile, validationErrorFromCause } from "../validation.ts";
import { type LandofileFinalizeOverrides, applyFinalizeOverrides } from "./finalize-overrides.ts";
import { finishClassifiedLoadStage } from "./load-stage.ts";
import {
  type LandofileLoadScope,
  buildLandofileLoadScope,
  materializeLandofileLayer,
} from "./materialize.ts";

export const finalizeLandofile = Effect.fn("Landofile.finalize")(function* (
  file: string,
  authoredDocument: AuthoredDocument,
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
    /** Observe the assembled document after tooling composition, before final refusal checks. */
    readonly onAssembled?: (document: AuthoredDocument) => void;
    readonly onDiagnostic?: (diagnostic: LandofileLintDiagnostic) => void;
    readonly onLoadBlocked?: (cause: RecordedLoadFailure | undefined) => void;
  },
) {
  // Replacement origins on overridden keys make every origin-filtered site consumer drop the
  // displaced expressions; shadowed `lando:` sites stay in scope for constraint accumulation.
  const document = applyFinalizeOverrides(authoredDocument, context.overrides);
  const recorder = context.recorder ?? context.scope?.recorder ?? createLoadFailureRecorder();
  if (context.onDiagnostic !== undefined) recorder.diagnostic = true;
  const scope = {
    ...(context.scope ??
      (yield* buildLandofileLoadScope([{ file, value: document.value }], context.env, context.pendingSites))),
    recorder,
  };
  const composed = yield* Effect.try({
    try: () =>
      composedCarrier({
        document: document.value,
        provenance: document.provenance,
        pendingSites: context.pendingSites ?? scope.pendingSites ?? [],
        context: captureCompilationContext(context.appRoot, scope.env),
      }),
    catch: (cause) => validationErrorFromCause(file, document.value, cause),
  }).pipe(
    Effect.catch((error) => {
      recorder.record(error);
      return Effect.succeed(undefined);
    }),
  );
  const composedDocument: AuthoredDocument = {
    value: composed !== undefined && isPlainRecord(composed.document) ? composed.document : document.value,
    provenance: document.provenance,
  };
  const materialized = yield* materializeLandofileLayer(file, composedDocument, {
    ...scope,
    siteFilter: (site) => site.path[0] !== "lando",
  });
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
    try: () => includeAcquisitionView(acquisitionDocument.value),
    catch: (cause) => validationErrorFromCause(file, acquisitionDocument.value, cause),
  }).pipe(
    Effect.catch((error) => {
      recorder.record(error);
      return Effect.succeed(includeAcquisitionView({}));
    }),
  );
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
    document: { value: acquisition, provenance: acquisitionDocument.provenance },
    loadScope: scope,
    appRoot: context.appRoot,
    sourceRoot: context.appRoot,
    ...(context.loadPolicy === undefined ? {} : { loadPolicy: context.loadPolicy }),
    ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
  });
  const ownOrigins = value.provenance.origins;
  const includedOrigins: LandofileProvenance["origins"] = {
    source: { file, layer: "canonical", path: [] },
    deleted: false,
    children: new Map([["tooling", tooling.tooling.origins]]),
  };
  const merged = mergeValuesWithOrigins(
    LandofileShape,
    { value: { tooling: tooling.tooling.value }, origins: includedOrigins },
    {
      value: Object.hasOwn(value.value, "tooling") ? { tooling: value.value.tooling } : {},
      origins: ownOrigins,
    },
  );
  const tasks = isPlainRecord(merged.value) ? merged.value.tooling : undefined;
  const { include: _include, includes: _includes, toolingIncludes: _toolingIncludes, ...rest } = value.value;
  const children = new Map(ownOrigins.children);
  const toolingOrigins = merged.origins.children.get("tooling");
  if (toolingOrigins !== undefined) children.set("tooling", toolingOrigins);
  const constraints = yield* loadVersionConstraints(
    ownVersionConstraintEntries(document, file, "canonical", 3),
    scope,
  );
  const assembledValue: Record<string, unknown> = {
    ...rest,
    ...(isPlainRecord(tasks) && Object.keys(tasks).length > 0 ? { tooling: tasks } : {}),
  };
  for (const entry of constraints)
    if (valueOriginAt(ownOrigins, ["lando"]).source.file === entry.source) assembledValue.lando = entry.range;
  const assembled: AuthoredDocument = {
    value: assembledValue,
    provenance: {
      ...value.provenance,
      origins: { ...ownOrigins, children },
      documents: [...value.provenance.documents, ...tooling.sources],
      referencedFiles: normalizeReferencedFiles([
        ...value.provenance.referencedFiles,
        ...tooling.referencedFiles,
      ]),
      localIncludePaths: normalizeLocalIncludePaths([
        ...value.provenance.localIncludePaths,
        ...tooling.localFragmentPaths,
      ]),
      internalToolingTasks: winningInternalToolingTasks([
        { tooling: tooling.tooling.value, internalTaskIds: tooling.internalTaskIds },
        {
          tooling: isPlainRecord(value.value.tooling) ? value.value.tooling : undefined,
          internalTaskIds: value.provenance.internalToolingTasks,
        },
      ]),
      versionConstraints: constraints,
    },
  };
  context.onAssembled?.(assembled);
  const effectiveOrigins = assembled.provenance.origins;
  const effectiveSites = survivingSites(effectiveOrigins, scope.pendingSites ?? []);
  const hostPortSite = hostReadinessPortSite(assembled.value, effectiveSites);
  if (hostPortSite !== undefined)
    recorder.record(servicePortSiteError(hostPortSite.source, "host-readiness"));
  const load =
    context.rootDocuments === undefined
      ? finishLoadStage(file, recorder)
      : finishClassifiedLoadStage(file, recorder, {
          appRoot: context.appRoot,
          documents: context.rootDocuments,
        });
  let diagnosticUnavailable: readonly LoadUnavailableSite[] | undefined;
  const finalize = Effect.gen(function* () {
    yield* Effect.forEach(recorder.effectiveChecks, (check) => check);
    const unsupportedPath = scanToolingForUnsupported(assembled.value)[0]?.path ?? [];
    yield* rejectUnsupportedToolingFeatures(
      valueOriginAt(effectiveOrigins, unsupportedPath).source.file,
      assembled.value,
    );
    const compose = firstComposeRejection(assembled.value);
    if (compose !== undefined) {
      return yield* Effect.fail(
        composeKeyRejectedError({
          source: valueOriginAt(effectiveOrigins, compose.path).source.file,
          match: compose,
        }),
      );
    }
    const dialectIssues = healthcheckDialectIssues(assembled, diagnosticUnavailable);
    if (dialectIssues.length > 0) {
      return yield* Effect.fail(
        landofileValidationError(file, dialectIssues, {
          headline: "Landofile mixes probe dialects within a source",
          remediation:
            "Use the replacement keys in each finding, or write the entire probe in Compose syntax with `test:`.",
          location: (issue) => {
            const { line } = attributeLintIssue(issue, "effective", assembled.provenance.documents);
            return line === undefined || issue.source === undefined || !("file" in issue.source)
              ? undefined
              : `${issue.source.file}:${line}`;
          },
        }),
      );
    }
    const validated = yield* validateLandofile(file, assembled.value, assembled.provenance);
    const defaults = applyToolingIncludeDefaults(validated, tooling.defaults, {
      included: tooling.tooling.value,
      authored: ownOrigins,
      effective: effectiveOrigins,
    });
    const decoded = defaults.document;
    const compiled = LoadScopedLandofile.make({
      stage: "load-scoped",
      document: decoded,
      pendingSites: [
        ...decodedPendingSites(assembled.value, decoded, effectiveSites),
        ...survivingSites(defaults.addedOrigins, scope.pendingSites ?? []),
      ],
      context: { appRoot: AbsolutePath.make(context.appRoot), env: scope.env },
      provenance: {
        ...assembled.provenance,
        landofilePath: file,
        origins: defaults.origins,
        appRoot: context.appRoot,
        environmentDependencies: unionEnvironmentDependencies(
          assembled.provenance.environmentDependencies,
          ...(scope.environmentRecorder === undefined ? [] : [scope.environmentRecorder.dependencies()]),
        ),
      } satisfies LandofileProvenance,
    });
    return compiled;
  });
  if (context.onDiagnostic === undefined) {
    yield* load;
    return yield* finalize;
  }
  const loaded = yield* load.pipe(Effect.result);
  if (Result.isSuccess(loaded)) return yield* finalize;
  const identityPending = effectiveSites.some((site) => site.path[0] === "name");
  const unavailable =
    !recorder.diagnostic || identityPending
      ? Result.fail(recorder.entries.find((entry) => entry.kind !== "local") ?? recorder.entries[0])
      : diagnosticUnavailableSites(assembled, recorder.entries);
  if (Result.isSuccess(unavailable)) {
    diagnosticUnavailable = unavailable.success;
    const diagnostic = yield* finalize.pipe(Effect.result);
    if (Result.isSuccess(diagnostic))
      context.onDiagnostic({ landofile: diagnostic.success, unavailable: unavailable.success });
  } else {
    context.onLoadBlocked?.(unavailable.failure);
  }
  return yield* Effect.fail(loaded.failure);
});
