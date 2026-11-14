import { DataTransferError, FileIoError, type FileIoOperation, safeFileIoError } from "@lando/sdk/errors";

/** The I/O owner chooses the role; normalized persistence causes retain their reason. */
export const dumpTransferError = (
  operation: FileIoOperation,
  path: string,
  error: unknown,
): DataTransferError => {
  const cause = error instanceof FileIoError ? error : safeFileIoError(operation, path, error);
  return new DataTransferError({
    message: cause.message,
    ...(operation === "read" ? { fromEndpoint: "hostPath" } : { toEndpoint: "hostPath" }),
    operation,
    remediation: cause.remediation,
    cause,
  });
};
