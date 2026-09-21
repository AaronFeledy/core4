import { Context, type Effect } from "effect";

import type {
  BuildPhaseFailedError,
  CapabilityError,
  CommandAliasConflictError,
  ConfigExpressionError,
  DataTreeOwnershipCapabilityError,
  EventError,
  HomePathCapabilityError,
  LandofileUnknownEventError,
  LandofileValidationError,
  NotImplementedError,
  PublicationUnsupportedError,
  RouteInputError,
} from "../errors/index.ts";
import type { AppPlan, LandofileShape, ProviderCapabilities } from "../schema/index.ts";
import type { ProviderError, ProviderSelectionError } from "./provider.ts";

export type AppPlannerError =
  | LandofileValidationError
  | RouteInputError
  | CapabilityError
  | NotImplementedError
  | PublicationUnsupportedError
  | CommandAliasConflictError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | LandofileUnknownEventError;

export type BuildError = EventError | ProviderSelectionError | ProviderError;
export type BuildAppError = BuildError | BuildPhaseFailedError;

export interface BuildAppOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<AppPlan, AppPlannerError>;
  }
>() {}

export class BuildOrchestrator extends Context.Tag("@lando/core/BuildOrchestrator")<
  BuildOrchestrator,
  {
    readonly build: (plan: AppPlan) => Effect.Effect<AppPlan, BuildError>;
    readonly buildApp: (plan: AppPlan, options?: BuildAppOptions) => Effect.Effect<void, BuildAppError>;
  }
>() {}
