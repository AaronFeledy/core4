import { Effect, Predicate, Result } from "effect";

import {
  LandofileExpressionEvalError,
  LandofileExpressionForbiddenError,
  LandofileExpressionParseError,
  LandofileImportRefMisuseError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
  LandofileParseError,
  LandofileValidationError,
} from "@lando/sdk/errors";
import {
  containsReservedBinding,
  evaluateTemplateEither,
  expressionInterpolationsTouchOnlyScopes,
  expressionScopeMembers,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { isLandofileOverride, isLandofileReset, override } from "@lando/sdk/landofile";

import type { ParsedPendingSite } from "@lando/sdk/schema";
import { INVOCATION_SCOPES, authoredSiteId, executableExpressionPath } from "./compiled-sites.ts";
import { decodeImplicitFileRef, makeLandofileLoadHelperOverrides } from "./load-expression-decoders.ts";
import { LandofileFileSession } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import {
  type ResolveLandofileLoadExpressionsOptions,
  callDepth,
  containsContextPath,
  containsLoad,
  invalidImportRefPath,
  keyValueEntryHasExpression,
  keyValueEntryPath,
  templateExpression,
} from "./load-expression-shape.ts";
import { LOAD_DEFERRED_EXPRESSION_SCOPES } from "./recipe-expressions.ts";
import { eligibleBindingPath } from "./secret-reference.ts";

export type { ResolveLandofileLoadExpressionsOptions } from "./load-expression-shape.ts";

export interface ResolvedLandofileLoadExpressions {
  readonly value: unknown;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly dependencies: ReadonlyArray<LandofileReferencedFile>;
  readonly relaxedReads: ReadonlyArray<{ readonly authoredPath: string; readonly absolutePath: string }>;
}

export type ResolveLandofileLoadExpressionError =
  | LandofileImportRefMisuseError
  | LandofileLoadLimitError
  | LandofileLoadOutsideRootError
  | LandofileParseError
  | LandofileValidationError;

export const resolveLandofileLoadExpressions = (
  options: ResolveLandofileLoadExpressionsOptions,
): Effect.Effect<ResolvedLandofileLoadExpressions, ResolveLandofileLoadExpressionError> =>
  Effect.try({
    try: () => {
      const session = new LandofileFileSession(options.source, options.policy);
      const pendingSites: ParsedPendingSite[] = [];
      const unsupported = (path: ReadonlyArray<string | number>, description: string): never => {
        const message = `${description} are not supported at ${path.join(".")}.`;
        const suggestion =
          "Use {{ env.NAME }} for host values, $${NAME} for literal shell text, or a supported deferred scope.";
        throw new LandofileValidationError({
          file: options.source.sourcePath,
          message,
          remediation: suggestion,
          issues: [
            {
              path,
              message,
              rule: "unsupported-expression",
              suggestion,
              source: { file: options.source.sourcePath, layer: options.source.layer, path },
            },
          ],
        });
      };
      const visit = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
        if (
          Predicate.isObject(value) &&
          "_tag" in value &&
          (value._tag === "SecretRef" || value._tag === "BoundText")
        )
          return unsupported(path, "Reserved binding objects");
        if (
          typeof value === "string" &&
          path[0] !== "recipe" &&
          (value.includes("{{") || value.includes("${"))
        ) {
          session.beginExpression();
          if (keyValueEntryHasExpression(value, path, options.source.sourcePath))
            return unsupported(path, "Key expressions");
          const text =
            typeof path.at(-1) === "number" && keyValueEntryPath(path) && value.includes("=")
              ? value.slice(value.indexOf("=") + 1)
              : value;
          const parsed = parseExpressionEither(text, {
            filePath: options.source.sourcePath,
            bareShellParameters: "preserve",
          });
          if (Result.isFailure(parsed))
            throw new LandofileValidationError({
              file: options.source.sourcePath,
              message: parsed.failure.message,
              remediation: parsed.failure.remediation,
              issues: [
                {
                  path,
                  message: parsed.failure.message,
                  source: { file: options.source.sourcePath, layer: options.source.layer, path },
                },
              ],
            });
          if (
            parsed.success.segments.some(
              (segment) =>
                segment.kind === "ShellParamSegment" ||
                (segment.kind === "SecretRefSegment" && !eligibleBindingPath(path)),
            )
          )
            return unsupported(path, "Configuration expressions");
          const secretMembers = expressionScopeMembers(parsed.success, "secrets");
          const scopes =
            eligibleBindingPath(path) && secretMembers.analyzable
              ? [...LOAD_DEFERRED_EXPRESSION_SCOPES, "secrets"]
              : LOAD_DEFERRED_EXPRESSION_SCOPES;
          const admittedScopes = executableExpressionPath(path) ? [...scopes, ...INVOCATION_SCOPES] : scopes;
          if (expressionInterpolationsTouchOnlyScopes(parsed.success, admittedScopes)) {
            if (
              parsed.success.segments.every(
                (segment) => segment.kind === "LiteralSegment" || segment.kind === "CommentSegment",
              )
            ) {
              const literal = evaluateTemplateEither(parsed.success, {});
              if (Result.isFailure(literal)) throw literal.failure;
              return text === value
                ? literal.success
                : `${value.slice(0, value.indexOf("=") + 1)}${String(literal.success)}`;
            }
            const source = { file: options.source.sourcePath, layer: options.source.layer, path };
            pendingSites.push({ id: authoredSiteId(source), path, source, template: parsed.success });
            return value;
          }
          const expression = templateExpression(parsed.success);
          if (expression === undefined || !containsLoad(expression) || containsContextPath(expression)) {
            return unsupported(path, "Template expressions");
          }
          const depth = callDepth(expression);
          if (depth > options.policy.maxRecursionDepth) {
            throw new LandofileLoadLimitError({
              message: `Landofile load/import recursion depth ${depth} exceeds the configured limit.`,
              kind: "recursion-depth",
              limit: options.policy.maxRecursionDepth,
              observed: depth,
              sourcePath: options.source.sourcePath,
              remediation: "Raise loadMaxRecursionDepth or simplify the expression.",
            });
          }
          const evaluated = evaluateTemplateEither(
            parsed.success,
            {},
            {
              filePath: options.source.sourcePath,
              helperOverrides: makeLandofileLoadHelperOverrides(session),
            },
          );
          if (Result.isFailure(evaluated)) throw evaluated.failure;
          const result = decodeImplicitFileRef(session, evaluated.success);
          if (containsReservedBinding(result))
            return unsupported(path, "Reserved binding objects from load/import");
          if (
            text !== value &&
            typeof result !== "string" &&
            typeof result !== "number" &&
            typeof result !== "boolean"
          )
            return unsupported(path, "Non-scalar environment list results");
          const producedImportRefPath = invalidImportRefPath(result, path);
          if (producedImportRefPath !== undefined) {
            throw new LandofileImportRefMisuseError({
              message: `import() is not accepted at ${producedImportRefPath.join(".")}.`,
              sourcePath: options.source.sourcePath,
              configPath: producedImportRefPath.join("."),
              acceptingPath: `services.${String(path[1] ?? "<name>")}.security.ca`,
              remediation: "Use load() for plain values or move import() under service security.ca.",
            });
          }
          return text === value ? result : `${value.slice(0, value.indexOf("=") + 1)}${String(result)}`;
        }
        if (isLandofileReset(value)) return value;
        if (isLandofileOverride(value)) return override(visit(value.value, path));
        if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
        if (!Predicate.isObject(value)) return value;
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => {
            if (key.includes("{{") || key.includes("${")) {
              const parsed = parseExpressionEither(key, {
                filePath: options.source.sourcePath,
                bareShellParameters: "preserve",
              });
              if (
                Result.isFailure(parsed) ||
                parsed.success.segments.some((segment) => segment.kind !== "LiteralSegment")
              )
                return unsupported([...path, key], "Key expressions");
            }
            return [key, visit(entry, [...path, key])];
          }),
        );
      };
      const value = visit(options.value, []);
      options.pendingSites?.push(...pendingSites);
      return {
        value,
        pendingSites,
        dependencies: session.dependencies,
        relaxedReads: session.relaxedReads,
      };
    },
    catch: (cause): ResolveLandofileLoadExpressionError => {
      if (
        cause instanceof LandofileImportRefMisuseError ||
        cause instanceof LandofileLoadLimitError ||
        cause instanceof LandofileLoadOutsideRootError ||
        cause instanceof LandofileValidationError
      )
        return cause;
      if (
        cause instanceof LandofileExpressionEvalError ||
        cause instanceof LandofileExpressionForbiddenError ||
        cause instanceof LandofileExpressionParseError
      ) {
        return new LandofileParseError({
          message: cause.message,
          filePath: options.source.sourcePath,
          line: undefined,
          column: undefined,
          remediation: cause.remediation,
          cause,
        });
      }
      return new LandofileParseError({
        message: cause instanceof Error ? cause.message : "Landofile load/import evaluation failed.",
        filePath: options.source.sourcePath,
        line: undefined,
        column: undefined,
        remediation: "Check the load/import expression and referenced local file.",
        cause,
      });
    },
  });
