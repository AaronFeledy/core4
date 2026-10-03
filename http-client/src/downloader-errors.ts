/**
 * Error mapping for the verified-artifact Downloader.
 */
import {
  DownloadChecksumError,
  DownloadFetchError,
  type DownloadOfflineError,
  DownloadPersistError,
  DownloadSizeMismatchError,
  type DownloadSourceForbiddenError,
} from "@lando/sdk/errors";
import type { VerifiedStreamError } from "@lando/sdk/verified-stream";
import type * as HttpClientError from "effect/http/HttpClientError";

export type DownloadError =
  | DownloadFetchError
  | DownloadChecksumError
  | DownloadSizeMismatchError
  | DownloadPersistError
  | DownloadOfflineError
  | DownloadSourceForbiddenError;

export const statusError = (status: number, origin: string): DownloadFetchError | undefined =>
  status >= 200 && status < 300
    ? undefined
    : new DownloadFetchError({
        message: `The download request failed with HTTP status ${status}.`,
        urlOrigin: origin,
        status,
      });

/** Convert Effect `HttpClientError` → `DownloadFetchError`, keeping cause/remediation. */
export const mapHttpClientError = (
  error: HttpClientError.HttpClientError,
  origin: string,
): DownloadFetchError => {
  const reason = error.reason;
  const cause = "cause" in reason ? reason.cause : undefined;
  const status = error.response?.status;
  let remediation: string | undefined;
  let message = error.message;
  if (cause !== undefined && typeof cause === "object" && cause !== null) {
    if ("remediation" in cause && typeof cause.remediation === "string") {
      remediation = cause.remediation;
    }
    // Prefer the nested trust/load message (e.g. missing CA PEM) over the generic
    // Effect transport wrapper ("Transport error (GET …)").
    if ("message" in cause && typeof cause.message === "string") {
      const nested = cause.message;
      if (nested.length > 0) message = nested;
    }
  }
  return new DownloadFetchError({
    message,
    urlOrigin: origin,
    ...(status === undefined ? {} : { status }),
    ...(remediation === undefined ? {} : { remediation }),
    ...(cause === undefined ? {} : { cause }),
  });
};

export const mapVerifiedError = (error: VerifiedStreamError, origin: string): DownloadError => {
  switch (error.reason) {
    case "checksum":
      return new DownloadChecksumError({
        message: error.message,
        urlOrigin: origin,
        expectedSha256: error.expectedSha256 ?? "",
        actualSha256: error.actualSha256 ?? "",
        ...(error.actualSizeBytes === undefined ? {} : { sizeBytes: error.actualSizeBytes }),
      });
    case "size":
      return new DownloadSizeMismatchError({
        message: error.message,
        urlOrigin: origin,
        expectedSizeBytes: error.expectedSizeBytes ?? 0,
        actualSizeBytes: error.actualSizeBytes ?? 0,
      });
    case "persist":
      return new DownloadPersistError({
        message: error.message,
        operation: "write",
        ...(error.cause === undefined ? {} : { cause: error.cause }),
      });
  }
};

/** Controlled, content-free failure summary — never raw URLs, query, or causes. */
export const failureDetailForError = (error: DownloadError): string => {
  switch (error._tag) {
    case "DownloadFetchError":
      return error.status === undefined ? "fetch-failed" : `fetch-failed status=${error.status}`;
    case "DownloadChecksumError":
      return "checksum-mismatch";
    case "DownloadSizeMismatchError":
      return "size-mismatch";
    case "DownloadPersistError":
      return `persist-failed operation=${error.operation}`;
    case "DownloadOfflineError":
      return "offline-cache-miss";
    case "DownloadSourceForbiddenError":
      return `source-forbidden reason=${error.reason}`;
  }
};

export const isDownloadError = (value: unknown): value is DownloadError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof value._tag === "string" &&
  value._tag.startsWith("Download");
