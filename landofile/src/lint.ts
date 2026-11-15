import { dirname } from "node:path";
import { canonicalJson } from "@lando/sdk/digest";
import type { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import { LandofileLoadFailure, landofileLoadFailures } from "@lando/sdk/errors";
import {
  type ConfigLintResult,
  type ConfigLintViolation,
  type LoadScopedLandofile,
  ServiceName,
  authoredProbeTargetError,
} from "@lando/sdk/schema";
import { Effect, Result, Schema, type Scope } from "effect";
import { createIncludeResolutionSession } from "./include-session.ts";
import { fragmentIssues, isToolingRefusal, unreportedToolingRefusals } from "./lint-fragments.ts";
import { healthcheckWarnings } from "./lint-healthcheck.ts";
import { loadFailureViolation } from "./lint-load-failure.ts";
import { routerBindWarnings } from "./lint-router.ts";
import { attributeLintIssue } from "./lint-source.ts";
import { appNameOf } from "./lint-violations.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import type { DeferredLoadRefusal } from "./load-failures.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { type SourceDocument, getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs, TemplateEngineInputs } from "./ports.ts";
import { inspectLandofileRootLayers } from "./root-compile.ts";
import { findDiscoveredLandofilePath } from "./service.ts";
import { prepareLandofileValue } from "./source.ts";

export { attributeEffectiveLintIssue } from "./lint-source.ts";

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
  let scope: "fragment" | "effective" = "fragment";
  const violations: ConfigLintViolation[] = [];
  let recordedFailures: readonly LandofileLoadFailure[] = [];
  let deferredRefusals: readonly DeferredLoadRefusal[] = [];
  let composed: unknown;
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
          acquired.runtime.recorder?.record(error);
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
    composed = merged;
    const roots = new Set(documents.map((document) => document.file));
    const retained = getSourceDocuments(merged);
    violations.push(...retained.filter((document) => !roots.has(document.file)).flatMap(fragmentIssues));
    documents = retained;
    const effective = yield* finalizeLandofile(file, merged, {
      scope: loadScope,
      appRoot: dirname(file),
      recorder: acquired.runtime.recorder,
      pendingSites: acquired.runtime.pendingSites,
      loadPolicy: acquired.runtime.policy,
      logger: acquired.runtime.logger,
      ...(templates?.context?.env === undefined ? {} : { env: templates.context.env }),
    }).pipe(Effect.result);
    const knownDocuments = new Set(documents);
    const finalizedDocuments = getSourceDocuments(merged);
    violations.push(
      ...finalizedDocuments.filter((document) => !knownDocuments.has(document)).flatMap(fragmentIssues),
    );
    documents = finalizedDocuments;
    if (Result.isFailure(effective)) return yield* Effect.fail(effective.failure);
    violations.push(...healthcheckWarnings(merged, documents), ...routerBindWarnings(merged, documents));
    for (const [name, service] of Object.entries(effective.success.document.services ?? {})) {
      for (const role of ["healthcheck", "readiness"] as const) {
        const probe = service[role];
        if (probe === undefined) continue;
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
    return effective.success;
  }).pipe(Effect.result);
  if (Result.isFailure(finalized)) {
    if (finalized.failure._tag === "LandofileFormConflictError") return yield* Effect.fail(finalized.failure);
    const errors =
      finalized.failure._tag === "LandofileLoadError"
        ? landofileLoadFailures(finalized.failure)
        : [finalized.failure];
    if (deferredRefusals.length > 0 || errors.some((error) => isToolingRefusal(composed, violations, error)))
      violations.push(...unreportedToolingRefusals(composed, violations, documents));
    for (const error of errors) {
      // A rejected Compose key or refused tooling key already has a located finding; a pathless copy only repeats it.
      const reportedRejection =
        (error._tag === "ComposeKeyRejectedError" &&
          violations.some((violation) => violation.rule === "landofile.compose-rejection")) ||
        isToolingRefusal(composed, violations, error) ||
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
  const unique = mergeLintFindings(violations);
  const app = Result.isSuccess(finalized)
    ? (finalized.success.document.name ?? "")
    : (documents.map((source) => appNameOf(source.document)).find((name) => name !== "") ?? "");
  const primarySource = unique[0]?.source;
  const primary = primarySource !== undefined && "file" in primarySource ? primarySource.file : file;
  return {
    landofilePath: file,
    result: {
      app,
      file: primary,
      valid: !unique.some((issue) => issue.severity === "error"),
      violations: unique,
    },
    ...(Result.isSuccess(finalized) ? { resolved: finalized.success } : {}),
  };
}, scopedSnapshot);

export const lintLandofile = (options: LintLandofileOptions = {}, inputs?: LandofileRuntimeInputs) =>
  lintLandofileSnapshot(options, inputs).pipe(Effect.map(({ result }) => result));
