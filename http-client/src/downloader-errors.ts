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
  HttpTrustError,
} from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import type { VerifiedStreamError } from "@lando/sdk/verified-stream";
import { Schema } from "effect";
import type * as HttpClientError from "effect/http/HttpClientError";

import { type DownloadSource, fetchFailure, transportReason } from "./downloader-failure.ts";
import { withoutFetchVerboseHint } from "./fetch-message.ts";

export type DownloadError =
  | DownloadFetchError
  | DownloadChecksumError
  | DownloadSizeMismatchError
  | DownloadPersistError
  | DownloadOfflineError
  | DownloadSourceForbiddenError;

export const statusError = (status: number, source: DownloadSource): DownloadFetchError | undefined =>
  status >= 200 && status < 300 ? undefined : fetchFailure(source, { reason: "http-status", status });

/** Convert Effect `HttpClientError` → `DownloadFetchError`, keeping cause/remediation. */
export const mapHttpClientError = (
  error: HttpClientError.HttpClientError,
  source: DownloadSource,
  redactor: Redactor,
): DownloadFetchError => {
  const reason = error.reason;
  const cause = "cause" in reason ? reason.cause : undefined;
  // A body read that fails after a 2xx is a transport failure, not an HTTP status problem.
  const responseStatus = error.response?.status;
  const status =
    responseStatus === undefined || (responseStatus >= 200 && responseStatus < 300)
      ? undefined
      : responseStatus;
  const trust = Schema.is(HttpTrustError)(cause) ? cause : undefined;
  const classified =
    trust !== undefined
      ? { reason: "trust" as const }
      : status !== undefined
        ? { reason: "http-status" as const }
        : transportReason(cause);
  const remediation =
    cause !== null &&
    typeof cause === "object" &&
    "remediation" in cause &&
    typeof cause.remediation === "string"
      ? cause.remediation
      : undefined;
  const mapped = fetchFailure(source, {
    ...classified,
    ...(remediation === undefined ? {} : { remediation }),
    ...(status === undefined ? {} : { status }),
    ...(trust === undefined ? {} : { trustCause: trust.kind, remediation: trust.remediation }),
    ...(classified.reason === "transport"
      ? { detail: withoutFetchVerboseHint(cause instanceof Error ? cause.message : error.message) }
      : {}),
    ...(cause === undefined ? {} : { cause: redactor.redactValue(cause) }),
  });
  return new DownloadFetchError({
    ...mapped,
    cause: mapped.cause,
    transportCode:
      mapped.transportCode === undefined ? undefined : redactor.redactString(mapped.transportCode),
    message: redactor.redactString(mapped.message),
    remediation: redactor.redactString(mapped.remediation),
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
        remediation: "Retry the download from a trusted source; the artifact checksum did not match.",
      });
    case "size":
      return new DownloadSizeMismatchError({
        message: error.message,
        urlOrigin: origin,
        expectedSizeBytes: error.expectedSizeBytes ?? 0,
        actualSizeBytes: error.actualSizeBytes ?? 0,
        remediation: "Retry the download from a trusted source; the artifact size did not match.",
      });
    case "persist":
      return new DownloadPersistError({
        message: error.message,
        operation: "write",
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        remediation:
          "Free disk space or repair the destination path and parent directory, then retry the download write.",
      });
  }
};

/** Controlled, content-free failure summary — never raw URLs, query, or causes. */
export const failureDetailForError = (error: DownloadError): string => {
  switch (error._tag) {
    case "DownloadFetchError":
      return `fetch-failed reason=${error.reason ?? "transport"}${error.status === undefined ? "" : ` status=${error.status}`}`;
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
