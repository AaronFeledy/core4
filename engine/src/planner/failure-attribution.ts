import { type LandofileProvenance, provenanceOf } from "@lando/landofile/provenance";
import { getExactLandofileValueSource, primaryIssueFile } from "@lando/landofile/validation";
import { ConfigExpressionError, LandofileValidationError, RouteInputError } from "@lando/sdk/errors";
import type { LoadScopedLandofile, ValidationIssuePath } from "@lando/sdk/schema";

interface FailureLocation {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot?: string | undefined;
  readonly file?: string | undefined;
  readonly resolution?:
    | {
        readonly landofilePath: string;
        readonly provenance: LandofileProvenance | undefined;
      }
    | undefined;
}

export function attributePlanningFailure<E>(error: E, input: FailureLocation): E;
export function attributePlanningFailure(error: unknown, input: FailureLocation): unknown {
  if (
    !(error instanceof LandofileValidationError) &&
    !(error instanceof RouteInputError) &&
    !(error instanceof ConfigExpressionError)
  )
    return error;

  const provenance = input.resolution?.provenance ?? provenanceOf(input.landofile);
  const authoredSourceAt = (path: ValidationIssuePath) =>
    path.length === 0 ? undefined : getExactLandofileValueSource(provenance, path);
  const fallback =
    input.resolution?.landofilePath ??
    input.file ??
    provenance?.landofilePath ??
    input.appRoot ??
    input.landofile.context.appRoot;

  if (error instanceof LandofileValidationError) {
    const issues = error.issues.map((issue) => {
      if (issue.source !== undefined) return issue;
      const source = authoredSourceAt(issue.path);
      return source === undefined ? issue : { ...issue, source };
    });
    return new LandofileValidationError({
      ...error,
      cause: error.cause,
      message: error.message,
      file: primaryIssueFile(issues, fallback),
      issues,
    });
  }
  if (error instanceof RouteInputError) {
    const file = error.file ?? authoredSourceAt(error.path)?.file ?? fallback;
    const otherFile = error.otherFile ?? authoredSourceAt(error.otherPath)?.file;
    if (file === error.file && otherFile === error.otherFile) return error;
    return new RouteInputError({
      ...error,
      message: error.message,
      file,
      ...(otherFile === undefined ? {} : { otherFile }),
    });
  }
  const source = error.source ?? authoredSourceAt(error.path);
  return new ConfigExpressionError({
    ...error,
    message: error.message,
    filePath: source !== undefined && "file" in source ? source.file : fallback,
    ...(source === undefined ? {} : { source }),
  });
}
