import { Effect, Either } from "effect";

import {
  LandofileExpressionEvalError,
  LandofileExpressionForbiddenError,
  LandofileExpressionParseError,
  LandofileImportRefMisuseError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
  LandofileParseError,
  NotImplementedError,
} from "@lando/sdk/errors";
import {
  type ExpressionNode,
  type ExpressionTemplate,
  evaluateTemplateEither,
  expressionTouchesOnlyScopes,
  parseExpressionEither,
} from "@lando/sdk/expressions";

import { decodeImplicitFileRef, makeLandofileLoadHelperOverrides } from "./load-expression-decoders.ts";
import {
  LandofileFileSession,
  type LandofileLoadPolicy,
  type LandofileLoadSource,
} from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";

export interface ResolveLandofileLoadExpressionsOptions {
  readonly value: unknown;
  readonly source: LandofileLoadSource;
  readonly policy: LandofileLoadPolicy;
}

export interface ResolvedLandofileLoadExpressions {
  readonly value: unknown;
  readonly dependencies: ReadonlyArray<LandofileReferencedFile>;
  readonly relaxedReads: ReadonlyArray<{ readonly authoredPath: string; readonly absolutePath: string }>;
}

export type ResolveLandofileLoadExpressionError =
  | LandofileImportRefMisuseError
  | LandofileLoadLimitError
  | LandofileLoadOutsideRootError
  | LandofileParseError
  | NotImplementedError;

const callDepth = (node: ExpressionNode): number => {
  switch (node.kind) {
    case "Literal":
    case "Path":
      return 0;
    case "ArrayLiteral":
      return Math.max(0, ...node.elements.map(callDepth));
    case "ObjectLiteral":
      return Math.max(0, ...node.entries.map((entry) => callDepth(entry.value)));
    case "Access":
      return callDepth(node.target);
    case "Conditional":
      return Math.max(callDepth(node.test), callDepth(node.consequent), callDepth(node.alternate));
    case "Call": {
      const nested = Math.max(0, ...node.args.map(callDepth));
      return node.callee === "load" || node.callee === "import" ? nested + 1 : nested;
    }
  }
};

const containsLoad = (node: ExpressionNode): boolean => {
  switch (node.kind) {
    case "Literal":
    case "Path":
      return false;
    case "ArrayLiteral":
      return node.elements.some(containsLoad);
    case "ObjectLiteral":
      return node.entries.some((entry) => containsLoad(entry.value));
    case "Access":
      return containsLoad(node.target);
    case "Conditional":
      return containsLoad(node.test) || containsLoad(node.consequent) || containsLoad(node.alternate);
    case "Call":
      return node.callee === "load" || node.callee === "import" || node.args.some(containsLoad);
  }
};

const containsContextPath = (node: ExpressionNode): boolean => {
  switch (node.kind) {
    case "Literal":
      return false;
    case "Path":
      return true;
    case "ArrayLiteral":
      return node.elements.some(containsContextPath);
    case "ObjectLiteral":
      return node.entries.some((entry) => containsContextPath(entry.value));
    case "Access":
      return (
        containsContextPath(node.target) ||
        node.segments.some((segment) => segment.type === "dynamic" && containsContextPath(segment.expr))
      );
    case "Conditional":
      return (
        containsContextPath(node.test) ||
        containsContextPath(node.consequent) ||
        containsContextPath(node.alternate)
      );
    case "Call":
      return node.args.some(containsContextPath);
  }
};

const templateExpression = (template: ExpressionTemplate): ExpressionNode | undefined => {
  if (!template.whole) return undefined;
  const segment = template.segments[0];
  return segment?.kind === "InterpolationSegment" ? segment.expression : undefined;
};

const acceptsImportRef = (path: ReadonlyArray<string | number>): boolean =>
  (path.length === 4 || (path.length === 5 && typeof path[4] === "number")) &&
  path[0] === "services" &&
  path[2] === "security" &&
  ["ca", "cas", "certificate-authority", "certificate-authorities"].includes(String(path[3]));

const invalidImportRefPath = (
  value: unknown,
  path: ReadonlyArray<string | number>,
): ReadonlyArray<string | number> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  if ("_tag" in value && value._tag === "ImportRef") return acceptsImportRef(path) ? undefined : path;
  for (const [key, entry] of Object.entries(value)) {
    const nestedPath = invalidImportRefPath(entry, [...path, Array.isArray(value) ? Number(key) : key]);
    if (nestedPath !== undefined) return nestedPath;
  }
  return undefined;
};

export const resolveLandofileLoadExpressions = (
  options: ResolveLandofileLoadExpressionsOptions,
): Effect.Effect<ResolvedLandofileLoadExpressions, ResolveLandofileLoadExpressionError> =>
  Effect.try({
    try: () => {
      const session = new LandofileFileSession(options.source, options.policy);
      const visit = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
        if (typeof value === "string" && (value.includes("{{") || value.includes("${"))) {
          session.beginExpression();
          const parsed = parseExpressionEither(value, { filePath: options.source.sourcePath });
          if (Either.isLeft(parsed)) throw parsed.left;
          if (expressionTouchesOnlyScopes(parsed.right, ["app", "proxy"])) {
            return value;
          }
          const expression = templateExpression(parsed.right);
          if (expression === undefined || !containsLoad(expression) || containsContextPath(expression)) {
            throw new NotImplementedError({
              message: `Configuration expressions are not supported in Alpha Landofiles at ${options.source.sourcePath}.`,
              commandId: "landofile.parse",
              remediation: "This configuration surface is not supported yet.",
            });
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
            parsed.right,
            {},
            {
              filePath: options.source.sourcePath,
              helperOverrides: makeLandofileLoadHelperOverrides(session),
            },
          );
          if (Either.isLeft(evaluated)) throw evaluated.left;
          const result = decodeImplicitFileRef(session, evaluated.right);
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
          return result;
        }
        if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
        if (typeof value !== "object" || value === null) return value;
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]),
        );
      };
      return {
        value: visit(options.value, []),
        dependencies: session.dependencies,
        relaxedReads: session.relaxedReads,
      };
    },
    catch: (cause): ResolveLandofileLoadExpressionError => {
      if (
        cause instanceof LandofileImportRefMisuseError ||
        cause instanceof LandofileLoadLimitError ||
        cause instanceof LandofileLoadOutsideRootError ||
        cause instanceof NotImplementedError
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
