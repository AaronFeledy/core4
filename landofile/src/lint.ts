import { basename, dirname } from "node:path";
import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import {
  type ConfigLintResult,
  type ConfigLintViolation,
  LandofileAuthoringFragmentNative,
  type LandofileShape,
  type ValidationIssue,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { analyzeComposeRejections } from "./compose/rejections.ts";
import { findLandofilePath } from "./discovery.ts";
import { LANDOFILE_LAYER_POSITIONS } from "./layers.ts";
import { healthcheckWarnings } from "./lint-healthcheck.ts";
import { attributeLintIssue } from "./lint-source.ts";
import { appNameOf, rejectionViolation, violationsFromSchema } from "./lint-violations.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { type SourceDocument, getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs, TemplateEngineInputs } from "./ports.ts";
import { acquireLandofileRootLayers } from "./root-compile.ts";
import { prepareLandofileValue } from "./source.ts";

import { getLandofileValueSource } from "./validation.ts";

export const attributeEffectiveLintIssue = (
  landofile: LandofileShape,
  issue: ValidationIssue & { readonly rule: string },
): ConfigLintViolation => {
  const source = getLandofileValueSource(landofile, issue.path) ?? issue.source;
  return attributeLintIssue(
    { ...issue, severity: "error", ...(source === undefined ? {} : { source }) },
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
  readonly resolved?: LandofileShape;
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
  const cwd = options.cwd ?? process.cwd();
  const templates = options.templates ?? inputs?.templates;
  const discovered = yield* Effect.tryPromise({
    try: () => findLandofilePath(cwd),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (Result.isFailure(discovered)) {
    if (discovered.failure instanceof LandofileFormConflictError)
      return yield* Effect.fail(discovered.failure);
    return {
      landofilePath: cwd,
      result: {
        app: "",
        file: cwd,
        valid: false,
        violations: [
          {
            rule: "landofile.discovery",
            severity: "error",
            path: [],
            scope: "fragment",
            message:
              discovered.failure instanceof Error
                ? discovered.failure.message
                : "Failed to discover Landofile.",
          },
        ],
      },
    };
  }
  const file = discovered.success;
  if (file === undefined)
    return yield* Effect.fail(
      new LandofileNotFoundError({ message: "No .lando.yml or .lando.ts found.", cwd }),
    );
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
    violations.push(...healthcheckWarnings(merged, documents));
    const effective = yield* finalizeLandofile(file, merged, {
      appRoot: dirname(file),
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
    if (error._tag === "LandofileValidationError")
      violations.push(...error.issues.map((issue) => attributeLintIssue(issue, "effective", documents)));
    else {
      const path = error._tag === "LandofileIncludeError" ? (error.path ?? []) : [];
      let errorFile = file;
      if (error._tag === "LandofileIncludeError" && error.file !== undefined) {
        errorFile = error.file;
      } else if ("filePath" in error) {
        errorFile = error.filePath;
      } else if ("sourceFile" in error) {
        errorFile = error.sourceFile;
      }
      const layer =
        (error._tag === "LandofileIncludeError" ? error.layer : undefined) ??
        documents.find((document) => document.file === errorFile)?.layer ??
        LANDOFILE_LAYER_POSITIONS.find((position) => basename(errorFile).startsWith(`${position.basename}.`))
          ?.layer ??
        "canonical";
      violations.push({
        rule: "landofile.load",
        severity: "error",
        path,
        scope,
        source: { file: errorFile, layer, path },
        message: error.message,
        ...(error._tag === "LandofileParseError" && error.line !== undefined ? { line: error.line } : {}),
        ...(error._tag === "LandofileParseError" && error.column !== undefined
          ? { column: error.column }
          : {}),
        ...("remediation" in error && error.remediation !== undefined
          ? { suggestion: error.remediation }
          : {}),
      });
    }
  }
  const unique = [...new Map(violations.map((issue) => [JSON.stringify(issue), issue])).values()];
  const app = Result.isSuccess(finalized)
    ? (finalized.success.name ?? "")
    : (documents.map((source) => appNameOf(source.document)).find((name) => name !== "") ?? "");
  const primary = unique[0]?.source?.file ?? file;
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
