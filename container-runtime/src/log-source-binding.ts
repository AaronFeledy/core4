import type { Effect, Scope } from "effect";

import type { ContainerHelperUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess } from "@lando/sdk/log-follow";
import type { ContainerHelperArtifact, ContainerHelperTarget } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient } from "./data-plane.ts";
import { scopedDockerLogFileAccess } from "./log-file-access.ts";

export type ResolveContainerHelper = (
  target: ContainerHelperTarget,
) => Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError>;

interface ProviderLogSourceOptions {
  readonly redactor?: Redactor;
  readonly providerId: string;
  readonly logFileAccess: LogFileAccess | undefined;
  /** The container platform; with `resolveHelper` it enables file sources without reading helper bytes. */
  readonly helperTarget: ContainerHelperTarget | undefined;
  readonly resolveHelper: ResolveContainerHelper | undefined;
}

export interface BoundLogSources {
  readonly logFileAccess?:
    | LogFileAccess<ProviderError>
    | Effect.Effect<LogFileAccess<ProviderError>, ProviderError, Scope.Scope>;
}

/** Target selection and capability policy stay with the provider. */
export const makeProviderLogSourceBinding = (options: ProviderLogSourceOptions) => ({
  supported:
    options.logFileAccess !== undefined ||
    (options.helperTarget !== undefined && options.resolveHelper !== undefined),
  bind: (api: DataPlaneApiClient | undefined, container: string | undefined): BoundLogSources => {
    if (options.logFileAccess !== undefined) return { logFileAccess: options.logFileAccess };
    const { helperTarget, resolveHelper } = options;
    if (
      api === undefined ||
      container === undefined ||
      helperTarget === undefined ||
      resolveHelper === undefined
    )
      return {};
    return {
      logFileAccess: scopedDockerLogFileAccess({
        providerId: options.providerId,
        api,
        container,
        resolveHelper: resolveHelper(helperTarget),
        ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      }),
    };
  },
});
