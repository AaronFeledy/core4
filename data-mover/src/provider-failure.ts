import { DataTransferError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";

const operationMessages = {
  pullArtifact: "Lando couldn't download the transfer helper image.",
  appliedPlans: "Lando couldn't inspect the applied application plans.",
  copyFromService: "Lando couldn't copy files from the service.",
  runStream: "Lando couldn't run the transfer command.",
  exportArtifact: "Lando couldn't export the image.",
  copyToService: "Lando couldn't copy files to the service.",
  listVolumes: "Lando couldn't inspect the volumes.",
  importArtifact: "Lando couldn't import the image.",
  snapshotVolume: "Lando couldn't snapshot the volume.",
  restoreVolume: "Lando couldn't restore the volume.",
} as const;

export const providerFailure = (
  operation: keyof typeof operationMessages,
  cause: ProviderError,
): DataTransferError =>
  new DataTransferError({
    message: operationMessages[operation],
    operation,
    cause,
    remediation: cause.remediation,
  });
