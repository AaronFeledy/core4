import { StateStoreError, newerStateRemediation } from "@lando/sdk/errors";

export const newerStateVersionError = ({
  reader,
  ...input
}: {
  readonly operation: string;
  readonly path: string;
  readonly storedVersion: number;
  readonly supportedVersion: number;
  readonly writtenBy?: string;
  readonly reader?: string | undefined;
}): StateStoreError =>
  new StateStoreError({
    ...input,
    reason: "newer-version",
    remediation: newerStateRemediation({ ...input, reader }),
  });

export type NewerVersionStoreError = StateStoreError & {
  readonly reason: "newer-version";
};

export const isNewerVersionStoreError = (cause: unknown): cause is NewerVersionStoreError =>
  cause instanceof StateStoreError && cause.reason === "newer-version";

export const storeErrorRemediation = (cause: unknown, fallback: string): string =>
  isNewerVersionStoreError(cause) ? cause.remediation : fallback;
