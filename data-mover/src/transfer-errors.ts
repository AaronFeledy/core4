import {
  DataChecksumMismatchError,
  DataTransferError,
  FileIoError,
  safeFileIoError,
} from "@lando/sdk/errors";
import type { DataEndpoint, DataTransferSpec } from "@lando/sdk/schema";
import type { VerifiedStreamError } from "@lando/sdk/verified-stream";

export const endpointName = (endpoint: DataEndpoint): string => {
  switch (endpoint._tag) {
    case "hostPath":
      return `hostPath:${endpoint.path}`;
    case "hostArchive":
      return `hostArchive:${endpoint.format}:${endpoint.path}`;
    case "stream":
      return "stream";
    case "volume":
      return `volume:${endpoint.app}:${endpoint.store}`;
    case "servicePath":
      return `servicePath:${endpoint.app}:${endpoint.service}:${endpoint.path}`;
    case "serviceCmd":
      return `serviceCmd:${endpoint.app}:${endpoint.service}`;
    case "artifact":
      return `artifact:${endpoint.ref}`;
    default:
      return endpoint satisfies never;
  }
};

export const mapVerifiedError = (error: VerifiedStreamError, spec: DataTransferSpec) => {
  switch (error.reason) {
    case "checksum":
      return new DataChecksumMismatchError({
        message: "Data transfer checksum did not match the expected SHA-256.",
        expectedSha256: error.expectedSha256 ?? spec.expectedDigest ?? "",
        actualSha256: error.actualSha256 ?? "",
        archivePath: spec.to._tag === "hostArchive" ? spec.to.path : undefined,
        remediation: "Retry the transfer from a trusted source; verification cannot be skipped.",
      });
    case "size":
      return new DataTransferError({
        message: error.message,
        fromEndpoint: endpointName(spec.from),
        toEndpoint: endpointName(spec.to),
        operation: "persist",
        remediation: "Retry the transfer from a trusted source with the expected byte size.",
        cause: error,
      });
    case "persist": {
      const cause = error.cause instanceof FileIoError ? error.cause : error;
      return new DataTransferError({
        message: error.message,
        fromEndpoint: endpointName(spec.from),
        toEndpoint: endpointName(spec.to),
        operation: "persist",
        remediation:
          cause instanceof FileIoError
            ? cause.remediation
            : "Check destination requirements and transfer preparation, then retry the transfer.",
        cause,
      });
    }
    default:
      return error.reason satisfies never;
  }
};

export const hostReadError = (path: string, cause: unknown, operation = "read-host"): DataTransferError => {
  const failure = safeFileIoError("read", path, cause);
  return new DataTransferError({
    message:
      failure.reason === "not-found"
        ? `Host data file not found: ${path}`
        : failure.reason === "permission-denied"
          ? `Host data file is not readable: ${path}`
          : "Failed to read host data endpoint.",
    fromEndpoint: `hostPath:${path}`,
    operation,
    cause: failure,
    remediation: failure.remediation,
  });
};
