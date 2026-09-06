import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "../engine-api.ts";
import { redactDetails, redactString, withApiReason } from "../redact.ts";

export interface ContainerDiedEventsOptions {
  readonly ctx: ProviderErrorContext;
  readonly now?: () => Date;
}

const eventWindowSeconds = 10 * 60;

const buildContainerDiedEventsRequest = (now: Date): EngineHttpRequest => {
  const until = Math.floor(now.getTime() / 1000);
  const since = until - eventWindowSeconds;
  const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["die"] }));
  return { method: "GET", path: `/libpod/events?since=${since}&until=${until}&filters=${filters}` };
};

const missingRequest = (ctx: ProviderErrorContext): ProviderInternalError =>
  new ProviderInternalError({
    providerId: ctx.providerId,
    operation: "containerDiedEvents",
    message: "The Podman API client does not support requests required for died-event collection.",
    remediation: ctx.remediation,
  });

const eventsFailure = (ctx: ProviderErrorContext, status: number, body: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "containerDiedEvents",
    message: redactString(withApiReason(`Podman event collection failed with HTTP ${status}.`, { body })),
    details: redactDetails({ status, body }),
    remediation: ctx.remediation,
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
  request: NonNullable<EngineHttpApi["request"]>,
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
  api: EngineHttpApi,
  options: ContainerDiedEventsOptions,
): Effect.Effect<ReadonlyArray<unknown>, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const request = api.request;
    const ctx = options.ctx;
    if (request === undefined) return yield* Effect.fail(missingRequest(ctx));
    const response = yield* request(buildContainerDiedEventsRequest((options.now ?? (() => new Date()))()));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(eventsFailure(ctx, response.status, response.body));
    }
    return yield* Effect.forEach(parseContainerEventPayloads(response.body), (payload) =>
      enrichOomKilled(request, payload),
    );
  });
