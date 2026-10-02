import type { LogFileAccess } from "@lando/sdk/log-follow";
import type { ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient } from "./data-plane.ts";
import { makeDockerLogFileAccess } from "./log-file-access.ts";

interface ProviderLogSourceOptions {
  readonly providerId: string;
  readonly logFileAccess: LogFileAccess | undefined;
  readonly helperPayload: Uint8Array | undefined;
}

/** Payload selection and capability policy stay with the provider. */
export const makeProviderLogSourceBinding = (options: ProviderLogSourceOptions) => ({
  supported: options.logFileAccess !== undefined || options.helperPayload !== undefined,
  bind: (
    api: DataPlaneApiClient | undefined,
    container: string | undefined,
  ): { readonly logFileAccess?: LogFileAccess<ProviderError> } => {
    const logFileAccess =
      options.logFileAccess ??
      (api === undefined || container === undefined || options.helperPayload === undefined
        ? undefined
        : makeDockerLogFileAccess({
            providerId: options.providerId,
            api,
            container,
            helperPayload: options.helperPayload,
          }));
    return logFileAccess === undefined ? {} : { logFileAccess };
  },
});
