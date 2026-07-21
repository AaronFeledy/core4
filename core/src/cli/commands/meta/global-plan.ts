import { Effect, ParseResult } from "effect";

import {
  type CapabilityError,
  type GlobalAppError,
  type LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  type LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  LandofileValidationError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type LandofileShape, LandofileShape as LandofileShapeSchema } from "@lando/sdk/schema";
import {
  AppPlanResolver,
  type AppPlanResolverError,
  type GlobalAppPlanResolution,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { parseLandofile } from "../../../landofile/parser.ts";
import { decodeOrFail } from "../../../schema/decode.ts";

export type LoadGlobalPlanResult = GlobalAppPlanResolution;

export type LoadGlobalPlanError =
  | AppPlanResolverError
  | CapabilityError
  | GlobalAppError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderUnavailableError;

export type LoadGlobalPlanServices = AppPlanResolver | RuntimeProviderRegistry;

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const validateGlobalLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<LandofileShape, LandofileValidationError> =>
  decodeOrFail(LandofileShapeSchema, (cause) => {
    const issues = validationIssues(cause);
    return new LandofileValidationError({
      message: `Landofile contains unsupported MVP keys: ${issues.join(", ")}. Remove unsupported keys or update the documented Landofile service schema.`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });

export const decodeGlobalLandofile = (input: {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}): Effect.Effect<LandofileShape, LandofileParseError | LandofileValidationError> =>
  parseLandofile(input).pipe(Effect.flatMap((parsed) => validateGlobalLandofile(input.file, parsed)));

export const loadGlobalPlan = (): Effect.Effect<
  LoadGlobalPlanResult,
  LoadGlobalPlanError,
  LoadGlobalPlanServices
> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    const resolver = yield* AppPlanResolver;
    return yield* resolver.global(capabilities);
  });
