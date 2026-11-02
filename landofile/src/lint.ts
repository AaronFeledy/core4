import { basename, dirname } from "node:path";
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
import { Effect, Result, Schema } from "effect";
import { createIncludeResolutionSession } from "./include-session.ts";
import { LANDOFILE_LAYER_POSITIONS } from "./layers.ts";
import { fragmentIssues } from "./lint-fragments.ts";
import { healthcheckWarnings } from "./lint-healthcheck.ts";
import { routerBindWarnings } from "./lint-router.ts";
import { attributeLintIssue, sourceCoordinates } from "./lint-source.ts";
import { appNameOf } from "./lint-violations.ts";
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

export const lintLandofileSnapshot = Effect.fn("Landofile.lintSnapshot")(function* (
  options: LintLandofileOptions = {},
  inputs?: LandofileRuntimeInputs,
): Effect.fn.Return<LandofileLintSnapshot, LandofileNotFoundError | LandofileFormConflictError> {
  const templates = options.templates ?? inputs?.templates;
  const { filePath: file } = yield* findDiscoveredLandofilePath(options.cwd);
  let documents: readonly SourceDocument[] = [];
  let scope: "fragment" | "effective" = "fragment";
  const violations: ConfigLintViolation[] = [];
  let recordedFailures: readonly LandofileLoadFailure[] = [];
  const finalized = yield* Effect.gen(function* () {
    const acquired = yield* inspectLandofileRootLayers(
      dirname(file),
      templates === undefined ? inputs : { ...inputs, templates },
    );
    recordedFailures = acquired.runtime.recorder?.failures ?? [];
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
        Effect.map(({ value }) => [{ layer, landofile: value }]),
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
    for (const error of errors) {
      // A rejected Compose key already has a field-level finding; a pathless copy only repeats it.
      const reportedRejection =
        error._tag === "ComposeKeyRejectedError" &&
        violations.some((violation) => violation.rule === "landofile.compose-rejection");
      if (error._tag === "LandofileValidationError")
        violations.push(
          ...error.issues.map((issue) =>
            attributeLintIssue(
              recordedFailures.includes(error) ? { ...issue, rule: "landofile.load" } : issue,
              "effective",
              documents,
            ),
          ),
        );
      else if (!reportedRejection) {
        const diagnosticSource = error._tag === "ConfigExpressionError" ? error.source : undefined;
        const path =
          error._tag === "LandofileIncludeError"
            ? (error.path ?? [])
            : error._tag === "ConfigExpressionError"
              ? error.path
              : error._tag === "LandofileLoadOutsideRootError" || error._tag === "LandofileLoadLimitError"
                ? (error.path ?? [])
                : error._tag === "LandofileImportRefMisuseError"
                  ? error.configPath.split(".").map((key) => (/^\d+$/.test(key) ? Number(key) : key))
                  : error._tag === "LandofileParseError"
                    ? (error.sourcePath ?? [])
                    : [];
        let errorFile = file;
        if (diagnosticSource !== undefined && "file" in diagnosticSource) {
          errorFile = diagnosticSource.file;
        } else if (error._tag === "LandofileIncludeError" && error.file !== undefined) {
          errorFile = error.file;
        } else if ("sourceFile" in error) {
          errorFile = error.sourceFile ?? ("filePath" in error ? error.filePath : file);
        } else if ("filePath" in error) {
          errorFile = error.filePath;
        } else if ("sourcePath" in error && typeof error.sourcePath === "string") {
          errorFile = error.sourcePath;
        }
        const retained = documents.find(
          (document) =>
            document.file === errorFile &&
            (diagnosticSource === undefined ||
              !("layer" in diagnosticSource) ||
              document.layer === diagnosticSource.layer),
        );
        const layer =
          ("layer" in error ? error.layer : undefined) ??
          retained?.layer ??
          LANDOFILE_LAYER_POSITIONS.find((position) =>
            basename(errorFile).startsWith(`${position.basename}.`),
          )?.layer ??
          "canonical";
        violations.push({
          rule: "landofile.load",
          severity: "error",
          path,
          scopes: [scope],
          source: diagnosticSource ?? { file: errorFile, layer, path },
          message: error.message,
          ...(error._tag === "LandofileParseError" && error.sourcePath === undefined
            ? {
                ...(error.line === undefined ? {} : { line: error.line }),
                ...(error.column === undefined ? {} : { column: error.column }),
              }
            : retained === undefined || path.length === 0
              ? {}
              : sourceCoordinates(retained, diagnosticSource?.path ?? path)),
          ...("remediation" in error && error.remediation !== undefined
            ? { suggestion: error.remediation }
            : {}),
        });
      }
    }
  }
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
});

export const lintLandofile = (options: LintLandofileOptions = {}, inputs?: LandofileRuntimeInputs) =>
  lintLandofileSnapshot(options, inputs).pipe(Effect.map(({ result }) => result));
