/**
 * Redacted lifecycle-event payloads for one verified download.
 */

import {
  DownloadProgressEvent,
  MessageWarnEvent,
  PostDownloadEvent,
  PreDownloadEvent,
} from "@lando/sdk/events";
import type { LandoEvent } from "@lando/sdk/services";
import type { DateTime } from "effect";

interface DownloadEventContext {
  readonly origin: string;
  readonly callerId: string | undefined;
  readonly expectedSizeBytes: number | undefined;
  /** Destination filename for file downloads; absent for memory downloads. */
  readonly filename: string | undefined;
  readonly redact: (text: string) => string;
}

interface PostEventInput {
  readonly outcome: "success" | "failure";
  readonly fromCache: boolean;
  readonly bytesDownloaded: number | undefined;
  readonly sha256: string | undefined;
  readonly durationMs: number;
  readonly failureDetail: string | undefined;
  readonly attempts: number;
  readonly timestamp: DateTime.Utc;
}

interface RetryWarningInput {
  readonly reason: string;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly timestamp: DateTime.Utc;
}

export const makeDownloadEventBuilders = (context: DownloadEventContext) => {
  const { origin, redact } = context;
  const caller = context.callerId === undefined ? {} : { callerId: redact(context.callerId) };
  return {
    pre: (timestamp: DateTime.Utc): LandoEvent =>
      PreDownloadEvent.make({
        eventName: "pre-download" as const,
        urlOrigin: origin,
        ...caller,
        ...(context.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: context.expectedSizeBytes }),
        timestamp,
      }),
    progress: (bytesDownloaded: number, timestamp: DateTime.Utc): LandoEvent =>
      DownloadProgressEvent.make({
        eventName: "download-progress" as const,
        urlOrigin: origin,
        ...caller,
        bytesDownloaded,
        ...(context.expectedSizeBytes === undefined ? {} : { totalBytes: context.expectedSizeBytes }),
        timestamp,
      }),
    post: (input: PostEventInput): LandoEvent =>
      PostDownloadEvent.make({
        eventName: "post-download" as const,
        urlOrigin: origin,
        ...caller,
        ...(input.bytesDownloaded === undefined ? {} : { bytesDownloaded: input.bytesDownloaded }),
        fromCache: input.fromCache,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        durationMs: input.durationMs,
        outcome: input.outcome,
        ...(input.failureDetail === undefined ? {} : { failureDetail: redact(input.failureDetail) }),
        ...(input.attempts > 0 ? { attempts: input.attempts } : {}),
        timestamp: input.timestamp,
      }),
    retryWarning: (input: RetryWarningInput): MessageWarnEvent =>
      MessageWarnEvent.make({
        body: redact(
          `Retrying ${context.filename ?? "download"} from ${origin} (attempt ${input.nextAttempt} of ${input.maxAttempts}): ${input.reason}.`,
        ),
        timestamp: input.timestamp,
      }),
  };
};
