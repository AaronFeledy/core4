import { Either, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { LogSource, type LogSource as LogSourceType } from "@lando/sdk/schema";

export interface MergeLogSourcesInput {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly base: "l337" | "lando";
  readonly typeSources: ReadonlyArray<unknown>;
  readonly userSources: ReadonlyArray<unknown>;
}

const issuePath = (serviceName: string): string => `services.${serviceName}.logs`;

const validationError = (
  input: Pick<MergeLogSourcesInput, "appRoot" | "serviceName">,
  message: string,
  issue: string,
): LandofileValidationError =>
  new LandofileValidationError({
    message,
    file: `${input.appRoot}/.lando.yml`,
    issues: [issue],
  });

const validateSourceShape = (
  input: Pick<MergeLogSourcesInput, "appRoot" | "serviceName">,
  source: LogSourceType,
  issue: string,
): LandofileValidationError | undefined => {
  if (!Schema.is(LogSource)(source)) {
    return validationError(input, `Service ${input.serviceName} declares an invalid log source.`, issue);
  }
  if (!source.path.startsWith("/")) {
    return validationError(
      input,
      `Service ${input.serviceName} log source ${String(source.id)} must use an absolute in-container path.`,
      `${issue}.path`,
    );
  }
  return undefined;
};

const validateUniqueSources = (
  input: Pick<MergeLogSourcesInput, "appRoot" | "serviceName">,
  sources: ReadonlyArray<unknown>,
  issue: string,
): LandofileValidationError | undefined => {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (!Schema.is(LogSource)(source)) {
      return validationError(
        input,
        `Service ${input.serviceName} declares an invalid log source.`,
        `${issue}[${index}]`,
      );
    }
    const shapeError = validateSourceShape(input, source, `${issue}[${index}]`);
    if (shapeError !== undefined) return shapeError;
    const id = String(source.id);
    if (seen.has(id)) {
      return validationError(
        input,
        `Service ${input.serviceName} declares duplicate log source id ${id}.`,
        `${issue}[${index}].id`,
      );
    }
    seen.add(id);
  }
  return undefined;
};

export const mergeLogSources = (
  input: MergeLogSourcesInput,
): Either.Either<ReadonlyArray<LogSourceType>, LandofileValidationError> => {
  const typeIssue = `${issuePath(input.serviceName)}.serviceType`;
  const userIssue = issuePath(input.serviceName);
  const typeError = validateUniqueSources(input, input.typeSources, typeIssue);
  if (typeError !== undefined) return Either.left(typeError);

  const userError = validateUniqueSources(input, input.userSources, userIssue);
  if (userError !== undefined) return Either.left(userError);

  const typeSources = input.typeSources.map((entry) => Schema.decodeUnknownSync(LogSource)(entry));
  const userSources = input.userSources.map((entry) => Schema.decodeUnknownSync(LogSource)(entry));

  if (input.base !== "lando") {
    const typeRedirect = typeSources.find((source) => source.strategy === "redirect");
    if (typeRedirect !== undefined) {
      return Either.left(
        validationError(
          input,
          `Service ${input.serviceName} log source ${String(typeRedirect.id)} uses strategy: redirect, but base: ${input.base} does not give Lando a build phase to redirect daemon logs. Use strategy: follow for BYO services.`,
          typeIssue,
        ),
      );
    }
    const userRedirect = userSources.find((source) => source.strategy === "redirect");
    if (userRedirect !== undefined) {
      return Either.left(
        validationError(
          input,
          `Service ${input.serviceName} log source ${String(userRedirect.id)} uses strategy: redirect, but base: ${input.base} does not give Lando a build phase to redirect daemon logs. Use strategy: follow for BYO services.`,
          userIssue,
        ),
      );
    }
  }

  const merged = new Map<string, LogSourceType>();
  for (const source of typeSources) {
    merged.set(String(source.id), source);
  }
  for (const source of userSources) {
    merged.set(String(source.id), source);
  }
  return Either.right([...merged.values()]);
};
