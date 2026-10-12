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
import type { ArtifactPullPolicy, ProviderError, ProviderSelectionError } from "./provider.ts";

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

export interface BuildOptions {
  /**
   * How referenced artifacts are acquired. Defaults to `"missing"` so routine starts
   * stay offline once artifacts are local; rebuild commands pass `"always"` to refresh tags.
   */
  readonly pull?: ArtifactPullPolicy;
}

export interface BuildAppOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export class AppPlanner extends Context.Service<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<AppPlan, AppPlannerError>;
  }
>()("@lando/core/AppPlanner") {}

export class BuildOrchestrator extends Context.Service<
  BuildOrchestrator,
  {
    readonly build: (plan: AppPlan, options?: BuildOptions) => Effect.Effect<AppPlan, BuildError>;
    readonly buildApp: (plan: AppPlan, options?: BuildAppOptions) => Effect.Effect<void, BuildAppError>;
  }
>()("@lando/core/BuildOrchestrator") {}
