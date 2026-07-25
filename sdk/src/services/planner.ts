import { Context, type Effect } from "effect";

import type {
  BuildPhaseFailedError,
  CapabilityError,
  EventError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
  PublicationUnsupportedError,
} from "../errors/index.ts";
import type { AppPlan, LandofileShape, ProviderCapabilities } from "../schema/index.ts";
import type { ProviderError } from "./provider.ts";

export interface BuildAppOptions {
  readonly force?: boolean;
}

export class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<
      AppPlan,
      LandofileValidationError | CapabilityError | NotImplementedError | PublicationUnsupportedError
    >;
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
