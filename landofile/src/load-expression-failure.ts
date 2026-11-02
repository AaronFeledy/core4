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
import type { LandofileLoadSource } from "./load-expression-file.ts";
import type { ResolveLandofileLoadExpressionError } from "./load-expression.ts";

export const normalizeLoadExpressionFailure = (
  cause: unknown,
  source: LandofileLoadSource,
  path?: readonly (string | number)[],
): ResolveLandofileLoadExpressionError => {
  if (path !== undefined && cause instanceof LandofileLoadOutsideRootError)
    return new LandofileLoadOutsideRootError({
      message: cause.message,
      remediation: cause.remediation,
      sourcePath: cause.sourcePath,
      authoredPath: cause.authoredPath,
      resolvedPath: cause.resolvedPath,
      appRoot: cause.appRoot,
      path,
      layer: source.layer,
    });
  if (path !== undefined && cause instanceof LandofileLoadLimitError)
    return new LandofileLoadLimitError({
      message: cause.message,
      remediation: cause.remediation,
      sourcePath: cause.sourcePath,
      authoredPath: cause.authoredPath,
      kind: cause.kind,
      limit: cause.limit,
      observed: cause.observed,
      path,
      layer: source.layer,
    });
  if (path !== undefined && cause instanceof LandofileParseError)
    return new LandofileParseError({
      message: cause.message,
      remediation: cause.remediation,
      filePath: cause.filePath,
      sourceFile: source.sourcePath,
      sourcePath: path,
      layer: source.layer,
      line: cause.line,
      column: cause.column,
      cause: cause.cause,
    });
  if (
    cause instanceof LandofileImportRefMisuseError ||
    cause instanceof LandofileLoadLimitError ||
    cause instanceof LandofileLoadOutsideRootError ||
    cause instanceof LandofileValidationError ||
    cause instanceof LandofileParseError
  )
    return cause;
  if (
    cause instanceof LandofileExpressionEvalError ||
    cause instanceof LandofileExpressionForbiddenError ||
    cause instanceof LandofileExpressionParseError
  )
    return new LandofileParseError({
      message: cause.message,
      filePath: source.sourcePath,
      line: undefined,
      column: undefined,
      ...(path === undefined ? {} : { sourcePath: path, layer: source.layer }),
      remediation: cause.remediation,
      cause,
    });
  if (path !== undefined) throw cause;
  return new LandofileParseError({
    message: cause instanceof Error ? cause.message : "Landofile load/import evaluation failed.",
    filePath: source.sourcePath,
    line: undefined,
    column: undefined,
    remediation: "Check the load/import expression and referenced local file.",
    cause,
  });
};
