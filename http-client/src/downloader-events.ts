/**
 * Redacted lifecycle-event seam for the verified-artifact Downloader.
 */
import { Cause, type Context, Effect, Option } from "effect";

import { createRedactor } from "@lando/sdk/secrets";
import type { EventService, LandoEvent } from "@lando/sdk/services";

import { type DownloadError, failureDetailForError, isDownloadError } from "./downloader-errors.ts";

/**
 * The redacted-event seam the downloader publishes its lifecycle scope through.
 * `redactText` masks secret values out of every free-string payload field
 * BEFORE construction; `publish` forwards the content-free event to the
 * `EventService` (failures swallowed — events are observational only).
 */
export interface DownloaderEvents {
  readonly redactText: (text: string) => string;
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

export const noopDownloaderEvents: DownloaderEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

/** Build a redacted, fail-open event seam from an optional `EventService`. */
export const makeDownloaderEvents = (
  eventService: Option.Option<Context.Service.Shape<typeof EventService>>,
): DownloaderEvents => {
  const redactText = createRedactor("secrets").redactString;
  const publish: DownloaderEvents["publish"] = Option.isSome(eventService)
    ? (event) => eventService.value.publish(event).pipe(Effect.catchCause(() => Effect.void))
    : () => Effect.void;
  return { redactText, publish };
};

/** Map a failed/interrupted exit cause to a controlled, content-free detail. */
export const failureDetailFromExitCause = (cause: Cause.Cause<DownloadError>): string => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (failure !== undefined && isDownloadError(failure)) return failureDetailForError(failure);
  if (Cause.hasInterrupts(cause)) return "interrupted";
  return "error";
};
