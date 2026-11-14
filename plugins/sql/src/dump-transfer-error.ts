import { DataTransferError, FileIoError, type FileIoOperation, safeFileIoError } from "@lando/sdk/errors";
import { VerifiedStreamError } from "@lando/sdk/verified-stream";

/** The I/O owner chooses the role; verification guards retain their original diagnostics. */
export const dumpTransferError = (
  operation: FileIoOperation,
  path: string,
  error: unknown,
): DataTransferError => {
  if (error instanceof VerifiedStreamError) {
    const cause = error.cause instanceof FileIoError ? error.cause : error;
    return new DataTransferError({
      message: error.message,
      toEndpoint: cause instanceof FileIoError ? "hostPath" : `hostPath:${path}`,
      operation,
      remediation:
        cause instanceof FileIoError
          ? cause.remediation
          : "Check dump verification requirements, destination requirements and transfer preparation, then retry.",
      cause,
    });
  }
  const cause = error instanceof FileIoError ? error : safeFileIoError(operation, path, error);
  return new DataTransferError({
    message: cause.message,
    ...(operation === "read" ? { fromEndpoint: "hostPath" } : { toEndpoint: "hostPath" }),
    operation,
    remediation: cause.remediation,
    cause,
  });
};
