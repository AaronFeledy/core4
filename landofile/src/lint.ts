import { dirname } from "node:path";
import { canonicalJson } from "@lando/sdk/digest";
import type { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import { LandofileLoadFailure, landofileLoadFailures } from "@lando/sdk/errors";
import {
  type ConfigLintResult,
  type ConfigLintSkip,
  type ConfigLintViolation,
  type LoadScopedLandofile,
  ServiceName,
  authoredProbeTargetError,
} from "@lando/sdk/schema";
import { Effect, Result, Schema, type Scope } from "effect";
import { createIncludeResolutionSession } from "./include-session.ts";
import { type LandofileLintDiagnostic, overlapsUnavailable } from "./lint-diagnostic.ts";
import { fragmentIssues, isToolingRefusal, unreportedToolingRefusals } from "./lint-fragments.ts";
import { healthcheckWarnings } from "./lint-healthcheck.ts";
import { loadFailureViolation } from "./lint-load-failure.ts";
import { routerBindWarnings } from "./lint-router.ts";
import { blockedLoadSkip, unavailableEntrySkips } from "./lint-skips.ts";

export { unavailableEntrySkips } from "./lint-skips.ts";

import { attributeLintIssue } from "./lint-source.ts";
import { appNameOf } from "./lint-violations.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import type { DeferredLoadRefusal, RecordedLoadFailure } from "./load-failures.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import type { LandofileRuntimeInputs, TemplateEngineInputs } from "./ports.ts";
import type { AuthoredDocument, SourceDocument } from "./provenance.ts";
import { inspectLandofileRootLayers } from "./root-compile.ts";
import { findDiscoveredLandofilePath } from "./service.ts";
import { prepareLandofileValue } from "./source.ts";
import { pathsOverlap, probeTargetIsBlocked } from "./validation-path.ts";

export { type LoadUnavailableSite, overlapsUnavailable } from "./lint-diagnostic.ts";
export { attributeEffectiveLintIssue, attributeLintIssue } from "./lint-source.ts";

export const mergeLintFindings = (
  findings: ReadonlyArray<ConfigLintViolation>,
): ReadonlyArray<ConfigLintViolation> => {
  const merged = new Map<string, ConfigLintViolation>();
  for (const { scopes, ...finding } of findings) {
    const key = canonicalJson(finding);
    const previous = merged.get(key);
    const combined = new Set([...(previous?.scopes ?? []), ...(scopes ?? [])]);
    merged.set(key, {
      ...finding,
      ...(previous?.scopes === undefined && scopes === undefined
        ? {}
        : { scopes: (["fragment", "effective"] as const).filter((scope) => combined.has(scope)) }),
    });
  }
  return [...merged.values()];
};

export interface LintLandofileOptions {
  readonly cwd?: string;
  readonly templates?: TemplateEngineInputs;
}
export interface LandofileLintSnapshot {
  readonly result: ConfigLintResult;
  readonly landofilePath: string;
  readonly resolved?: LoadScopedLandofile;
  readonly diagnostic?: LandofileLintDiagnostic;
}

// Effect.fn infers the call signature from its combinators, so the scope combinator restates the args.
const scopedSnapshot = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
  _options: LintLandofileOptions = {},
  _inputs?: LandofileRuntimeInputs,
) => Effect.scoped(effect);

export const lintLandofileSnapshot = Effect.fn("Landofile.lintSnapshot")(function* (
  options: LintLandofileOptions = {},
  inputs?: LandofileRuntimeInputs,
): Effect.fn.Return<LandofileLintSnapshot, LandofileNotFoundError | LandofileFormConflictError, Scope.Scope> {
  const templates = options.templates ?? inputs?.templates;
  const { filePath: file } = yield* findDiscoveredLandofilePath(options.cwd);
  let documents: readonly SourceDocument[] = [];
  let knownDocuments: ReadonlySet<SourceDocument> = new Set();
  let scope: "fragment" | "effective" = "fragment";
  const violations: ConfigLintViolation[] = [];
  let recordedFailures: readonly LandofileLoadFailure[] = [];
  let deferredRefusals: readonly DeferredLoadRefusal[] = [];
  let composed: unknown;
  let assembled: AuthoredDocument | undefined;
  let diagnostic: LandofileLintDiagnostic | undefined;
  let blockedLoad: RecordedLoadFailure | undefined;
  let skipped: readonly ConfigLintSkip[] | undefined;
  const finalized = yield* Effect.gen(function* () {
    const acquired = yield* inspectLandofileRootLayers(
      dirname(file),
      templates === undefined ? inputs : { ...inputs, templates },
    );
    recordedFailures = acquired.runtime.recorder?.failures ?? [];
    deferredRefusals = acquired.runtime.recorder?.deferredRefusals ?? [];
    documents = acquired.sources.map(({ source, layer }) => ({
      file: source.file,
      form: source.form,
      layer: layer.layer,
      document: source.value,
      content: source.content,
      digest: source.digest,
    }));
    violations.push(...documents.flatMap(fragmentIssues));
    scope = "effective";
    const prepared = yield* Effect.forEach(acquired.sources, ({ source, layer }) =>
      prepareLandofileValue(source).pipe(
        Effect.map(({ value }) => [
          {
            layer,
            landofile:
              acquired.runtime.recorder === undefined
                ? value
                : prepareIncludeAcquisition(value, {
                    recorder: acquired.runtime.recorder,
                    source: { file: layer.filePath, layer: layer.layer, path: [] },
                  }),
          },
        ]),
        Effect.catch((error) => {
          if (!Schema.is(LandofileLoadFailure)(error)) return Effect.fail(error);
          acquired.runtime.recorder?.record(error, { kind: "missing-content" });
          return Effect.succeed([]);
        }),
      ),
    );
    const session = yield* createIncludeResolutionSession({ appRoot: dirname(file), ...inputs });
    const { document: merged, scope: loadScope } = yield* composePreparedLayers(
      prepared.flat(),
      acquired.runtime,
      {
        session,
        ...(inputs === undefined ? {} : { inputs }),
      },
    );
    composed = merged.value;
    const roots = new Set(documents.map((document) => document.file));
    const retained = merged.provenance.documents;
    violations.push(...retained.filter((document) => !roots.has(document.file)).flatMap(fragmentIssues));
    documents = retained;
    knownDocuments = new Set(documents);
    const effective = yield* finalizeLandofile(file, merged, {
      scope: loadScope,
      appRoot: dirname(file),
      recorder: acquired.runtime.recorder,
      pendingSites: acquired.runtime.pendingSites,
      loadPolicy: acquired.runtime.policy,
      logger: acquired.runtime.logger,
      onAssembled: (document) => {
        assembled = document;
      },
      onDiagnostic: (value) => {
        diagnostic = value;
      },
      onLoadBlocked: (cause) => {
        blockedLoad = cause;
      },
      ...(templates?.context?.env === undefined ? {} : { env: templates.context.env }),
    }).pipe(Effect.result);
    const finalizedDocuments = merged.provenance.documents;
    violations.push(
      ...finalizedDocuments.filter((document) => !knownDocuments.has(document)).flatMap(fragmentIssues),
    );
    documents = finalizedDocuments;
    const available = Result.isSuccess(effective) ? effective.success : diagnostic?.landofile;
    const unavailable = diagnostic?.unavailable ?? [];
    if (available !== undefined)
      violations.push(
        ...healthcheckWarnings(merged, unavailable),
        ...routerBindWarnings(merged).filter((finding) => !overlapsUnavailable(finding.path, unavailable)),
      );
    for (const [name, service] of Object.entries(available?.document.services ?? {})) {
      for (const role of ["healthcheck", "readiness"] as const) {
        const probe = service[role];
        if (probe === undefined || overlapsUnavailable(["services", name, role], unavailable)) continue;
        if (
          available?.pendingSites.length &&
          probeTargetIsBlocked(["services", name, role], (path) =>
            available.pendingSites.some((site) => pathsOverlap(site.path, path)),
          )
        )
          continue;
        const invalid = authoredProbeTargetError(probe, ServiceName.make(name), role);
        if (invalid === undefined) continue;
        violations.push(
          attributeLintIssue(
            {
              rule: `${role}.execution-target`,
              severity: "error",
              path: ["services", name, role],
              message: invalid.message,
              suggestion: invalid.remediation,
            },
            "effective",
            documents,
          ),
        );
      }
    }
    return yield* Effect.fromResult(effective);
  }).pipe(Effect.result);
  if (Result.isFailure(finalized)) {
    if (finalized.failure._tag === "LandofileFormConflictError") return yield* Effect.fail(finalized.failure);
    const errors =
      finalized.failure._tag === "LandofileLoadError"
        ? landofileLoadFailures(finalized.failure)
        : [finalized.failure];
    if (diagnostic === undefined && errors[0] !== undefined) {
      skipped = [
        blockedLoadSkip({ failure: errors[0], recorded: blockedLoad, context: { file, scope, documents } }),
      ];
    }
    // A refused root stops finalization before the composed value exists; the assembled
    // document still holds the tooling tasks the include contributed.
    const assembledValue = assembled?.value ?? composed;
    const assembledDocuments = assembled?.provenance.documents ?? documents;
    violations.push(
      ...assembledDocuments.filter((document) => !knownDocuments.has(document)).flatMap(fragmentIssues),
    );
    if (
      deferredRefusals.length > 0 ||
      errors.some((error) => isToolingRefusal(assembledValue, violations, error))
    )
      violations.push(...unreportedToolingRefusals(assembledValue, violations, assembledDocuments));
    for (const error of errors) {
      // A rejected Compose key or refused tooling key already has a located finding; a pathless copy only repeats it.
      const reportedRejection =
        (error._tag === "ComposeKeyRejectedError" &&
          violations.some((violation) => violation.rule === "landofile.compose-rejection")) ||
        isToolingRefusal(assembledValue, violations, error) ||
        deferredRefusals.some((refusal) => refusal.error === error);
      if (error._tag === "LandofileValidationError")
        violations.push(
          ...error.issues.map((issue) =>
            attributeLintIssue(
              recordedFailures.includes(error) &&
                issue.rule !== undefined &&
                issue.rule !== "landofile.validation"
                ? { ...issue, rule: "landofile.load", reason: issue.rule }
                : issue,
              "effective",
              documents,
            ),
          ),
        );
      else if (!reportedRejection) violations.push(loadFailureViolation(error, { file, scope, documents }));
    }
  }
  violations.push(
    ...deferredRefusals.map(({ error, source }) =>
      attributeLintIssue(
        {
          rule: "landofile.load",
          reason: error._tag,
          path: source.path,
          source,
          message: error.message,
          suggestion: error.remediation,
        },
        "fragment",
        documents,
      ),
    ),
  );
  const rejectedExpressionSources = new Set(
    violations.flatMap(({ rule, reason, source }) =>
      rule === "landofile.load" && reason === "unsupported-expression" && source !== undefined
        ? [canonicalJson(source)]
        : [],
    ),
  );
  for (const { source } of deferredRefusals) rejectedExpressionSources.add(canonicalJson(source));
  const unique = mergeLintFindings(
    violations.filter(
      ({ rule, source }) =>
        rule !== "landofile.validation" ||
        source === undefined ||
        !rejectedExpressionSources.has(canonicalJson(source)),
    ),
  );
  const app = Result.isSuccess(finalized)
    ? (finalized.success.document.name ?? "")
    : (documents.map((source) => appNameOf(source.document)).find((name) => name !== "") ?? "");
  const primarySource = unique[0]?.source;
  const primary = primarySource !== undefined && "file" in primarySource ? primarySource.file : file;
  if (diagnostic?.unavailable.length) skipped = unavailableEntrySkips(diagnostic.unavailable);
  return {
    landofilePath: file,
    result: {
      app,
      file: primary,
      valid: !unique.some((issue) => issue.severity === "error"),
      violations: unique,
      ...(skipped === undefined ? {} : { skipped }),
    },
    ...(Result.isSuccess(finalized) ? { resolved: finalized.success } : {}),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}, scopedSnapshot);

export const lintLandofile = (options: LintLandofileOptions = {}, inputs?: LandofileRuntimeInputs) =>
  lintLandofileSnapshot(options, inputs).pipe(Effect.map(({ result }) => result));
