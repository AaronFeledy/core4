import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";
import { redactDetails, redactString, withApiReason } from "./redact.ts";

const PROVIDER_ID = "lando";
const EVENTS_REMEDIATION =
  "Run `lando doctor` to inspect the Lando runtime, then retry. Run `lando setup` if the runtime is not installed or healthy.";

export interface ContainerDiedEventsOptions {
  readonly providerId?: string;
  readonly now?: () => Date;
}

const eventWindowSeconds = 10 * 60;

const buildContainerDiedEventsRequest = (now: Date): PodmanHttpRequest => {
  const until = Math.floor(now.getTime() / 1000);
  const since = until - eventWindowSeconds;
  const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["die"] }));
  return { method: "GET", path: `/libpod/events?since=${since}&until=${until}&filters=${filters}` };
};

const missingRequest = (providerId: string): ProviderInternalError =>
  new ProviderInternalError({
    providerId,
    operation: "containerDiedEvents",
    message: "The Podman API client does not support requests required for died-event collection.",
    remediation: EVENTS_REMEDIATION,
  });

const eventsFailure = (providerId: string, status: number, body: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId,
    operation: "containerDiedEvents",
    message: redactString(withApiReason(`Podman event collection failed with HTTP ${status}.`, { body })),
    details: redactDetails({ status, body }),
    remediation: EVENTS_REMEDIATION,
  });

export const parseContainerEventPayloads = (body: string): ReadonlyArray<unknown> => {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const parsed = parseJson(trimmed);
  if (Array.isArray(parsed)) return Array.from(parsed);
  return trimmed.split(/\r?\n/u).flatMap((line) => {
    const parsedLine = parseJson(line);
    return parsedLine === undefined ? [] : [parsedLine];
  });
};

const parseJson = (value: string): unknown | undefined => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const containerIdForEvent = (payload: unknown): string | undefined => {
  const event = asRecord(payload);
  const actor = asRecord(event?.Actor);
  const id = event?.id ?? event?.ID ?? actor?.ID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const enrichOomKilled = (
  request: NonNullable<PodmanApiClient["request"]>,
  payload: unknown,
): Effect.Effect<unknown> => {
  const event = asRecord(payload);
  const containerId = containerIdForEvent(payload);
  if (event === undefined || containerId === undefined || event.OOMKilled === true) {
    return Effect.succeed(payload);
  }

  return request({ method: "GET", path: `/containers/${encodeURIComponent(containerId)}/json` }).pipe(
    Effect.map((response) => {
      if (response.status < 200 || response.status >= 300) return payload;
      const inspect = asRecord(parseJson(response.body));
      const state = asRecord(inspect?.State);
      return state?.OOMKilled === true ? { ...event, OOMKilled: true } : payload;
    }),
    Effect.catchAll(() => Effect.succeed(payload)),
  );
};

export const getContainerDiedEvents = (
  api: PodmanApiClient,
  options: ContainerDiedEventsOptions = {},
): Effect.Effect<ReadonlyArray<unknown>, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const request = api.request;
    const providerId = options.providerId ?? PROVIDER_ID;
    if (request === undefined) return yield* Effect.fail(missingRequest(providerId));
    const response = yield* request(buildContainerDiedEventsRequest((options.now ?? (() => new Date()))()));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(eventsFailure(providerId, response.status, response.body));
    }
    return yield* Effect.forEach(parseContainerEventPayloads(response.body), (payload) =>
      enrichOomKilled(request, payload),
    );
  });
