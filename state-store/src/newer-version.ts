import { StateStoreError } from "@lando/sdk/errors";

export const newerStateVersionError = (input: {
  readonly operation: string;
  readonly path: string;
  readonly storedVersion: number;
  readonly supportedVersion: number;
}): StateStoreError =>
  new StateStoreError({
    ...input,
    reason: "newer-version",
    remediation: `A newer Lando wrote ${input.path} (envelope version ${input.storedVersion}; this Lando supports ${input.supportedVersion}). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.`,
  });

export type NewerVersionStoreError = StateStoreError & {
  readonly reason: "newer-version";
};

export const isNewerVersionStoreError = (cause: unknown): cause is NewerVersionStoreError =>
  cause instanceof StateStoreError && cause.reason === "newer-version";

export const storeErrorRemediation = (cause: unknown, fallback: string): string =>
  isNewerVersionStoreError(cause) ? cause.remediation : fallback;
