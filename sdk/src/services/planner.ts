import { Context, type Effect } from "effect";

import type {
  BuildPhaseFailedError,
  CapabilityError,
  EventError,
  GlobalAppError,
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "../errors/index.ts";
import type { AppPlan, LandofileShape, ProviderCapabilities, RouteAuthorityPorts } from "../schema/index.ts";
import type { FileSystemError } from "./file-system.ts";
import type { GlobalAppPaths } from "./global-app.ts";
import type { ProviderError } from "./provider.ts";

export interface BuildAppOptions {
  readonly force?: boolean;
}

export interface AppPlannerOptions {
  readonly kind: "user" | "global" | "scratch";
  readonly routeAuthorityPorts?: RouteAuthorityPorts;
}

export interface AppPlanResolveOptions {
  readonly kind: "user" | "scratch";
}

export interface MissingGlobalAppPlan {
  readonly materialized: false;
  readonly paths: GlobalAppPaths;
}

export interface ResolvedGlobalAppPlan {
  readonly materialized: true;
  readonly paths: GlobalAppPaths;
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly routeAuthorityPorts?: RouteAuthorityPorts;
}

export type GlobalAppPlanResolution = MissingGlobalAppPlan | ResolvedGlobalAppPlan;

export type AppPlanResolverError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NotImplementedError;

export class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
      options: AppPlannerOptions,
    ) => Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError>;
  }
>() {}

export class AppPlanResolver extends Context.Tag("@lando/core/AppPlanResolver")<
  AppPlanResolver,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
      options: AppPlanResolveOptions,
    ) => Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError>;
    readonly global: (
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<GlobalAppPlanResolution, AppPlanResolverError>;
  }
>() {}

export class BuildOrchestrator extends Context.Tag("@lando/core/BuildOrchestrator")<
  BuildOrchestrator,
  {
    readonly build: (
      plan: AppPlan,
    ) => Effect.Effect<
      AppPlan,
      EventError | NoProviderInstalledError | ProviderConfigError | ProviderError | ProviderUnavailableError
    >;
    readonly buildApp: (
      plan: AppPlan,
      options?: BuildAppOptions,
    ) => Effect.Effect<
      void,
      | BuildPhaseFailedError
      | EventError
      | NoProviderInstalledError
      | ProviderConfigError
      | ProviderError
      | ProviderUnavailableError
    >;
  }
>() {}
