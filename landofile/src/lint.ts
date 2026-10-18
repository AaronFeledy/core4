/**
 * Validates discovered Landofile layers against `LandofileShape` without
 * running translators, provider probes, or runtime capability scanners.
 * Unknown keys remain structured lint violations rather than runtime errors.
 */
import { dirname } from "node:path";
import type { SchemaIssue } from "effect";

import { Effect, Predicate, Result, Schema } from "effect";

import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import { composeTopLevelDispositions, decodeLandofileLayer, mergeValues } from "@lando/sdk/landofile";
import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_TOP_LEVEL_KEYS,
  type ConfigLintResult,
  type ConfigLintViolation,
  LandofileShape,
  ServiceConfig,
  type ValidationIssuePath,
  formatValidationIssuePath,
  parseValidationIssuePath,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { buildLandofileLoadScope, materializeLandofileLayer } from "./compile.ts";
import { type ComposeRejectionMatch, analyzeComposeRejections } from "./compose/rejections.ts";
import { LANDOFILE_NAME, LANDOFILE_TS_NAME, findLandofilePath } from "./discovery.ts";
import { presentLandofileLayers } from "./layers.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import type { TemplateEngineInputs } from "./ports.ts";
import { normalizeRoutes } from "./route-normalize.ts";
import { prepareLandofileSource, resolveLandofileSourceExpressions } from "./service.ts";
import { type SchemaIssueLeaf, plannerScopeSuggestion, schemaIssueLeaves } from "./validation.ts";

export interface LintLandofileOptions {
  /** Directory to search upward from for a Landofile. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly templates?: TemplateEngineInputs;
}

const decodeLandofile = Schema.decodeUnknownResult(LandofileShape);

const lastKey = (path: ReadonlyArray<PropertyKey>): string | undefined =>
  path.length === 0 ? undefined : String(path[path.length - 1]);

const MISPLACED_COMPOSE_SURFACE_REMEDIATION = {
  profiles:
    'The top-level key "profiles" is not a Compose top-level key; profiles is a service-level key. Split profile-specific config into separate Landofile fragments and select them with includes: instead.',
  extensions:
    'The top-level key "extensions" is not a Compose key. Use an x-* top-level extension or move provider-specific data under providers.<provider-id>.',
} as const;

const isAcceptedComposeTopLevelKey = (key: string): boolean =>
  (COMPOSE_TOP_LEVEL_KEYS as ReadonlyArray<string>).includes(key) || key.startsWith("x-");

const isDeprecatedComposeTopLevelKey = (key: string): boolean =>
  (COMPOSE_DEPRECATED_TOP_LEVEL_KEYS as ReadonlyArray<string>).includes(key);

const isMisplacedComposeSurfaceKey = (
  key: string,
): key is keyof typeof MISPLACED_COMPOSE_SURFACE_REMEDIATION =>
  Object.prototype.hasOwnProperty.call(MISPLACED_COMPOSE_SURFACE_REMEDIATION, key);

const composeSuggestedFix = (issue: SchemaIssueLeaf): string | undefined => {
  // Compose dispositions apply only to top-level schema issues.
  if (issue.path.length !== 1) return undefined;
  const key = String(issue.path[0]);
  if (issue._tag === "Unexpected") {
    const disposition = composeTopLevelDispositions[key];
    if (disposition?.disposition === "rejected") return disposition.remediation;
    return isMisplacedComposeSurfaceKey(key) ? MISPLACED_COMPOSE_SURFACE_REMEDIATION[key] : undefined;
  }
  if (issue._tag !== "Type" || issue.message.startsWith("Expected undefined")) return undefined;
  if (isAcceptedComposeTopLevelKey(key)) {
    return `The top-level Compose key "${key}" is accepted, but this value does not match Lando's supported schema-backed subset. Use only the supported shape for ${key}.`;
  }
  if (isDeprecatedComposeTopLevelKey(key)) {
    return `The top-level Compose key "${key}" is accepted only for compatibility and is ignored by Lando. Remove it from new Landofiles.`;
  }
  return undefined;
};

const toIssuePath = (path: ReadonlyArray<PropertyKey>): ValidationIssuePath =>
  path.map((segment) => (typeof segment === "number" ? segment : String(segment)));

const pathFromText = (text: string): ValidationIssuePath => parseValidationIssuePath(text) ?? [];

const SERVICE_CONFIG_KEYS = [...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"];

const closestKeySuggestions = (issue: SchemaIssue.Issue): ReadonlyMap<string, string> =>
  new Map(
    validationIssuesFromSchemaIssue(issue, {
      extraAllowedKeys: (path) => (path[0] === "services" && path.length >= 3 ? SERVICE_CONFIG_KEYS : []),
    }).flatMap((entry) =>
      entry.suggestion === undefined
        ? []
        : [[formatValidationIssuePath(entry.path), entry.suggestion] as const],
    ),
  );

const violationFromIssue = (
  issue: SchemaIssueLeaf,
  suggestions: ReadonlyMap<string, string>,
): ConfigLintViolation => {
  const path = toIssuePath(issue.path);
  const formatted = formatValidationIssuePath(path);
  const key = lastKey(issue.path);
  const suggestion =
    (issue._tag === "Type" && formatted === "sshAgent.socket"
      ? "Set sshAgent.socket to a string containing the host SSH-agent socket path, or omit it for automatic discovery."
      : undefined) ??
    composeSuggestedFix(issue) ??
    (issue._tag === "Unexpected"
      ? (suggestions.get(formatted) ??
        `Remove the unknown key${key === undefined ? "" : ` "${key}"`}; it is not part of the canonical Landofile schema.`)
      : issue._tag === "Missing"
        ? `Add the required "${key ?? formatted}" field.`
        : undefined);
  return suggestion === undefined
    ? { path, message: issue.message }
    : { path, message: issue.message, suggestion };
};

const rejectionViolation = (match: ComposeRejectionMatch): ConfigLintViolation => ({
  path: pathFromText(match.documentPath),
  message: `Compose key "${match.matrixPath}" is rejected: ${match.rationale}`,
  suggestion: match.remediation,
});

const fallsWithinRejectedPath = (path: string, rejectedPath: string): boolean =>
  path === rejectedPath || path.startsWith(`${rejectedPath}.`) || path.startsWith(`${rejectedPath}[`);

const violationsFor = (
  parsed: unknown,
  rejections: ReadonlyArray<ComposeRejectionMatch> = [],
): ReadonlyArray<ConfigLintViolation> => {
  const decoded = decodeLandofile(parsed, { onExcessProperty: "error", errors: "all" });
  return Result.isSuccess(decoded)
    ? [
        ...Object.entries(decoded.success.services ?? {}).map(([name, service]) =>
          normalizeRoutes(service.routes ?? [], { keyPath: `services.${name}.routes` }),
        ),
        ...Object.entries(decoded.success.proxy ?? {}).map(([name, routes]) =>
          normalizeRoutes(routes, { keyPath: `proxy.${name}` }),
        ),
      ].flatMap((result) =>
        Result.match(result, {
          onFailure: (error) => [
            { path: pathFromText(error.key), message: error.message, suggestion: error.remediation },
          ],
          onSuccess: () => [],
        }),
      )
    : schemaIssueLeaves(decoded.failure.issue)
        .map((issue) => {
          const violation = violationFromIssue(issue, closestKeySuggestions(decoded.failure.issue));
          const suggestion =
            issue._tag === "Type" ? plannerScopeSuggestion(parsed, violation.path) : undefined;
          return suggestion === undefined ? violation : { ...violation, suggestion };
        })
        .filter(
          (violation) =>
            !rejections.some((rejection) =>
              fallsWithinRejectedPath(formatValidationIssuePath(violation.path), rejection.documentPath),
            ),
        );
};

const appNameOf = (parsed: unknown): string => {
  if (!Predicate.isObjectOrArray(parsed)) return "";
  const name = (parsed as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "";
};

const singleViolationResult = (
  file: string,
  message: string,
  details: {
    readonly line: number | undefined;
    readonly column: number | undefined;
    readonly suggestion?: string | undefined;
  } = {
    line: undefined,
    column: undefined,
  },
): ConfigLintResult => ({
  app: "",
  file,
  valid: false,
  violations: [
    {
      path: [],
      message,
      ...(details.line === undefined ? {} : { line: details.line }),
      ...(details.column === undefined ? {} : { column: details.column }),
      ...(details.suggestion === undefined ? {} : { suggestion: details.suggestion }),
    },
  ],
});

/**
 * Lint the Landofile discovered upward from `cwd` against the canonical
 * schema. Resolves with a structured `ConfigLintResult` for any reachable,
 * parseable-or-not file. Fails only when no Landofile exists at all.
 */
export const lintLandofile = Effect.fn("Landofile.lint")(function* (
  options: LintLandofileOptions = {},
): Effect.fn.Return<ConfigLintResult, LandofileNotFoundError | LandofileFormConflictError> {
  const cwd = options.cwd ?? process.cwd();
  const discovery = yield* Effect.tryPromise({
    try: () => findLandofilePath(cwd),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (Result.isFailure(discovery)) {
    if (discovery.failure instanceof LandofileFormConflictError) return yield* Effect.fail(discovery.failure);
    const message =
      discovery.failure instanceof Error ? discovery.failure.message : "Failed to discover Landofile.";
    return singleViolationResult(cwd, message);
  }
  const filePath = discovery.success;
  if (filePath === undefined) {
    return yield* Effect.fail(
      new LandofileNotFoundError({
        message: `No ${LANDOFILE_NAME} or ${LANDOFILE_TS_NAME} found. Searched from ${cwd} upward.`,
        cwd,
      }),
    );
  }

  const layersDiscovery = yield* Effect.tryPromise({
    try: () => presentLandofileLayers(dirname(filePath)),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (Result.isFailure(layersDiscovery)) {
    if (layersDiscovery.failure instanceof LandofileFormConflictError) {
      return yield* Effect.fail(layersDiscovery.failure);
    }
    const message =
      layersDiscovery.failure instanceof Error
        ? layersDiscovery.failure.message
        : "Failed to discover Landofile layers.";
    return singleViolationResult(filePath, message);
  }

  const parsedLayers: unknown[] = [];
  const layerRejections: Array<ReadonlyArray<ComposeRejectionMatch>> = [];
  for (const layer of layersDiscovery.success) {
    const prepared = yield* prepareLandofileSource(
      layer.filePath,
      {
        appRoot: dirname(filePath),
        layer: layer.layer,
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      },
      options.templates === undefined ? undefined : { templates: options.templates },
    ).pipe(Effect.flatMap(resolveLandofileSourceExpressions), Effect.result);
    if (Result.isFailure(prepared)) {
      const error = prepared.failure;
      return singleViolationResult(layer.filePath, error.message, {
        line: "line" in error ? error.line : undefined,
        column: "column" in error ? error.column : undefined,
        suggestion: "remediation" in error ? error.remediation : undefined,
      });
    }
    parsedLayers.push(prepared.success.value);
    layerRejections.push(analyzeComposeRejections(prepared.success.value));
  }

  const scopeResult = yield* buildLandofileLoadScope(
    parsedLayers.map((value, index) => ({
      file: layersDiscovery.success[index]?.filePath ?? filePath,
      value,
    })),
    options.templates?.context?.env,
  ).pipe(Effect.result);
  if (Result.isFailure(scopeResult)) {
    const error = scopeResult.failure;
    const authoredFile = error._tag === "LandofileValidationError" ? error.file : error.filePath;
    return {
      app: appNameOf(
        parsedLayers.find((_value, index) => layersDiscovery.success[index]?.filePath === authoredFile),
      ),
      file: authoredFile,
      valid: false,
      violations:
        error._tag === "LandofileValidationError" ? error.issues : [{ path: [], message: error.message }],
    };
  }

  const decodedLayers: unknown[] = [];
  for (const [index, value] of parsedLayers.entries()) {
    const authoredFile = layersDiscovery.success[index]?.filePath ?? filePath;
    const materialized = yield* materializeLandofileLayer(authoredFile, value, scopeResult.success).pipe(
      Effect.result,
    );
    if (Result.isFailure(materialized))
      return {
        app: appNameOf(value),
        file: authoredFile,
        valid: false,
        violations: materialized.failure.issues,
      };
    const decoded = yield* decodeLandofileLayer(
      layersDiscovery.success[index]?.filePath ?? filePath,
      materialized.success,
    ).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      if (decoded.failure._tag === "LandofileValidationError")
        return {
          app: appNameOf(value),
          file: layersDiscovery.success[index]?.filePath ?? filePath,
          valid: false,
          violations: decoded.failure.message.startsWith("Invalid Landofile layer.")
            ? [
                ...(layerRejections[index] ?? []).map(rejectionViolation),
                ...violationsFor(materialized.success, layerRejections[index] ?? []),
              ]
            : decoded.failure.issues.map((issue) => ({ ...issue })),
        };
      return singleViolationResult(filePath, decoded.failure.message, {
        line: decoded.failure.line,
        column: decoded.failure.column,
        suggestion: decoded.failure.remediation,
      });
    }
    decodedLayers.push(decoded.success);
  }

  const parsed = decodedLayers.reduce<unknown>(
    (merged, layer) => mergeValues(LandofileShape, merged, layer),
    {},
  );
  const rejections = layerRejections.flat();
  const rejectionViolations = rejections.map(rejectionViolation);
  const mergedViolations = violationsFor(parsed, rejections);
  const violations: Array<ConfigLintViolation> = [];
  const violationKeys = new Set<string>();
  for (const violation of [...rejectionViolations, ...mergedViolations]) {
    const key = JSON.stringify(violation);
    if (violationKeys.has(key)) continue;
    violationKeys.add(key);
    violations.push(violation);
  }
  for (const [index, layer] of decodedLayers.entries()) {
    for (const violation of violationsFor(
      mergeValues(LandofileShape, {}, layer),
      layerRejections[index] ?? [],
    )) {
      const key = JSON.stringify(violation);
      if (violationKeys.has(key)) continue;
      violationKeys.add(key);
      violations.push(violation);
    }
  }

  return {
    app: appNameOf(parsed),
    file: filePath,
    valid: violations.length === 0,
    violations,
  };
});
