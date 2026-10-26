import { basename, dirname } from "node:path";
import { canonicalJson } from "@lando/sdk/digest";
import type { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import {
  type ConfigLintResult,
  type ConfigLintViolation,
  LandofileAuthoringFragmentNative,
  type LandofileShape,
  type LoadScopedLandofile,
  type ValidationIssue,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { analyzeComposeRejections } from "./compose/rejections.ts";
import { LANDOFILE_LAYER_POSITIONS } from "./layers.ts";
import { healthcheckWarnings } from "./lint-healthcheck.ts";
import { routerBindWarnings } from "./lint-router.ts";
import { attributeLintIssue, sourceCoordinates } from "./lint-source.ts";
import { appNameOf, rejectionViolation, violationsFromSchema } from "./lint-violations.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { type SourceDocument, getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs, TemplateEngineInputs } from "./ports.ts";
import { acquireLandofileRootLayers } from "./root-compile.ts";
import { findDiscoveredLandofilePath } from "./service.ts";
import { prepareLandofileValue } from "./source.ts";

import { getLandofileValueSource } from "./validation.ts";

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

export const attributeEffectiveLintIssue = (
  landofile: LandofileShape,
  issue: ValidationIssue & { readonly rule: string; readonly severity?: "error" | "warning" },
): ConfigLintViolation => {
  const source = issue.source ?? getLandofileValueSource(landofile, issue.path);
  return attributeLintIssue(
    { ...issue, severity: issue.severity ?? "error", ...(source === undefined ? {} : { source }) },
    "effective",
    getSourceDocuments(landofile),
  );
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

const fragmentIssues = (source: SourceDocument): readonly ConfigLintViolation[] => {
  const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(source.document, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Result.isSuccess(decoded)) return [];
  const rejections = analyzeComposeRejections(source.document);
  const issues = [
    ...rejections.map(rejectionViolation),
    ...violationsFromSchema(decoded.failure.issue, source.document, rejections),
  ];
  return issues.map((issue) =>
    attributeLintIssue(
      { ...issue, source: { file: source.file, layer: source.layer, path: issue.path } },
      "fragment",
      [source],
    ),
  );
};

export const lintLandofileSnapshot = Effect.fn("Landofile.lintSnapshot")(function* (
  options: LintLandofileOptions = {},
  inputs?: LandofileRuntimeInputs,
): Effect.fn.Return<LandofileLintSnapshot, LandofileNotFoundError | LandofileFormConflictError> {
  const templates = options.templates ?? inputs?.templates;
  const { filePath: file } = yield* findDiscoveredLandofilePath(options.cwd);
  let documents: readonly SourceDocument[] = [];
  let scope: "fragment" | "effective" = "fragment";
  const violations: ConfigLintViolation[] = [];
  const finalized = yield* Effect.gen(function* () {
    const acquired = yield* acquireLandofileRootLayers(
      dirname(file),
      templates === undefined ? inputs : { ...inputs, templates },
    );
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
      prepareLandofileValue(source).pipe(Effect.map(({ value }) => ({ layer, landofile: value }))),
    );
    const merged = yield* composePreparedLayers(prepared, acquired.runtime, inputs);
    const roots = new Set(documents.map((document) => document.file));
    const retained = getSourceDocuments(merged);
    violations.push(...retained.filter((document) => !roots.has(document.file)).flatMap(fragmentIssues));
    documents = retained;
    violations.push(...healthcheckWarnings(merged, documents), ...routerBindWarnings(merged, documents));
    const effective = yield* finalizeLandofile(file, merged, {
      appRoot: dirname(file),
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
    return effective.success;
  }).pipe(Effect.result);
  if (Result.isFailure(finalized)) {
    const error = finalized.failure;
    if (error._tag === "LandofileFormConflictError") return yield* Effect.fail(error);
    // A rejected Compose key already has a field-level finding; a pathless copy only repeats it.
    const reportedRejection =
      error._tag === "ComposeKeyRejectedError" &&
      violations.some((violation) => violation.rule === "landofile.compose-rejection");
    if (error._tag === "LandofileValidationError")
      violations.push(...error.issues.map((issue) => attributeLintIssue(issue, "effective", documents)));
    else if (!reportedRejection) {
      const path =
        error._tag === "LandofileIncludeError"
          ? (error.path ?? [])
          : error._tag === "ConfigExpressionError"
            ? error.path
                .split(".")
                .filter(Boolean)
                .map((key) => (/^\d+$/.test(key) ? Number(key) : key))
            : [];
      let errorFile = file;
      if (error._tag === "LandofileIncludeError" && error.file !== undefined) {
        errorFile = error.file;
      } else if ("filePath" in error) {
        errorFile = error.filePath;
      } else if ("sourceFile" in error) {
        errorFile = error.sourceFile;
      }
      const retained = documents.find((document) => document.file === errorFile);
      const layer =
        (error._tag === "LandofileIncludeError" ? error.layer : undefined) ??
        retained?.layer ??
        LANDOFILE_LAYER_POSITIONS.find((position) => basename(errorFile).startsWith(`${position.basename}.`))
          ?.layer ??
        "canonical";
      violations.push({
        rule: "landofile.load",
        severity: "error",
        path,
        scopes: [scope],
        source: { file: errorFile, layer, path },
        message: error.message,
        ...(error._tag === "LandofileParseError"
          ? {
              ...(error.line === undefined ? {} : { line: error.line }),
              ...(error.column === undefined ? {} : { column: error.column }),
            }
          : retained === undefined || path.length === 0
            ? {}
            : sourceCoordinates(retained, path)),
        ...("remediation" in error && error.remediation !== undefined
          ? { suggestion: error.remediation }
          : {}),
      });
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
