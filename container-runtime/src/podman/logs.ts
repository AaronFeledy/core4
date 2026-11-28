import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Option, Schema, type Scope, Stream } from "effect";
import {
  type EngineHttpApi,
  type EngineHttpRequest,
  type ProviderErrorContext,
  isSuccessStatus,
} from "../engine-api.ts";
import { missingApi, missingService, serviceNotRunning } from "../engine-errors.ts";
import { serviceContainerName } from "../plan.ts";
import { httpStatusOf } from "../redact.ts";
import { runStatusFromEngineState } from "../run-observation.ts";
import { decodeLogStream } from "../streams.ts";

export interface LogsOptions {
  readonly api?: EngineHttpApi;
  /** Shared access, or a scoped acquisition run once per followed source. */
  readonly logFileAccess?: LogFileAccess | Effect.Effect<LogFileAccess, ProviderError, Scope.Scope>;
  readonly ctx: ProviderErrorContext;
}

// Docker and Podman answer the logs and exec-create requests for a container that does not exist
// with HTTP 404 before streaming anything.
const containerAbsent = (error: ProviderError): boolean =>
  error instanceof ProviderUnavailableError && httpStatusOf(error.details) === 404;

/** A service with no container (never started, or destroyed) has no logs, even when following. */
const emptyWhenContainerAbsent = <A>(
  logs: Stream.Stream<A, ProviderError>,
): Stream.Stream<A, ProviderError> => logs.pipe(Stream.catchIf(containerAbsent, () => Stream.empty));

const decodeInspectStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ State: Schema.Struct({ Status: Schema.String }) })),
);

const stream = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
): Stream.Stream<Uint8Array, ProviderError> =>
  deps.api.stream === undefined ? Stream.fail(missingApi(deps.ctx, "logs")) : deps.api.stream(input);

export const containerConsoleLogs = (
  api: EngineHttpApi,
  ctx: ProviderErrorContext,
  container: string,
  service: ServiceName,
  options: Partial<LogOptions>,
): Stream.Stream<LogChunk, ProviderError> => {
  const selected = options.sources?.find((source) => source.id === options.source);
  const pipe = selected?.strategy === "follow" ? undefined : selected?.stream;
  const query = new URLSearchParams({
    stdout: String(pipe === undefined || pipe === "stdout"),
    stderr: String(pipe === undefined || pipe === "stderr"),
    follow: String(options.follow ?? true),
    timestamps: "true",
  });
  if (options.tail !== undefined) query.set("tail", String(options.tail));
  if (options.since !== undefined) query.set("since", options.since);
  return decodeLogStream(
    emptyWhenContainerAbsent(
      stream(
        { api, ctx },
        {
          method: "GET",
          path: `/containers/${encodeURIComponent(container)}/logs?${query}`,
        },
      ),
    ),
  ).pipe(
    Stream.filter((line) => pipe === undefined || line.stream === pipe),
    Stream.map((line) => ({ service, ...line, ...(selected === undefined ? {} : { source: selected.id }) })),
  );
};

const fileSourceSince = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = DateTime.make(value);
  return Option.isNone(parsed) ? undefined : Math.floor(DateTime.toEpochMillis(parsed.value) / 1000);
};

export const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsOptions,
): Stream.Stream<LogChunk, ProviderError> =>
  Stream.suspend(() => {
    const ctx = runtime.ctx;
    const service = plan.services[target.service];
    if (service === undefined) {
      return Stream.fail(missingService(ctx, target, "logs"));
    }
    if (runtime.api === undefined) {
      return Stream.fail(missingApi(ctx, "logs"));
    }

    const api = runtime.api;
    const container = serviceContainerName(plan, service.name);
    const logFileAccess = runtime.logFileAccess;
    const logSources = options.sources ?? service.logSources ?? [];
    const selected = logSources.find((source) => source.id === options.source);
    if (selected !== undefined && selected.strategy !== "follow") {
      return containerConsoleLogs(api, ctx, container, service.name, {
        ...options,
        sources: [selected],
      });
    }
    const since = fileSourceSince(options.since);

    return Stream.suspend(() => {
      const fileStream: Stream.Stream<LogChunk, ProviderError> =
        logFileAccess === undefined || !logSources.some((source) => source.strategy === "follow")
          ? Stream.empty
          : logFollowLineChunks(
              followLogSources({
                service: service.name,
                sources: logSources,
                follow: options.follow ?? true,
                access: logFileAccess,
                ...(options.tail === undefined ? {} : { tail: options.tail }),
                ...(since === undefined ? {} : { since }),
                ...(options.source === undefined ? {} : { source: options.source }),
              }),
            );

      const files = fileStream.pipe(
        Stream.catchCause((cause) => {
          if (!cause.reasons.every(Cause.isFailReason)) return Stream.failCause(cause);
          if (cause.reasons.every((reason) => containerAbsent(reason.error))) return Stream.empty;
          if (api.request === undefined) return Stream.failCause(cause);
          // Exec-create failure codes differ by engine.
          return Stream.unwrap(
            api.request({ method: "GET", path: `/containers/${encodeURIComponent(container)}/json` }).pipe(
              Effect.option,
              Effect.map((response) => {
                if (Option.isNone(response)) return Stream.failCause(cause);
                if (response.value.status === 404) return Stream.empty;
                if (!isSuccessStatus(response.value.status)) return Stream.failCause(cause);
                const decoded = decodeInspectStatus(response.value.body);
                if (Option.isNone(decoded)) return Stream.failCause(cause);
                const status = runStatusFromEngineState(decoded.value.State.Status);
                switch (status) {
                  case "created":
                  case "exited":
                  case "dead":
                    return selected?.strategy === "follow"
                      ? Stream.fail(serviceNotRunning(ctx, service.name, status))
                      : Stream.empty;
                  case "absent":
                  case "running":
                  case "paused":
                  case "restarting":
                  case "removing":
                  case "unknown":
                    return Stream.failCause(cause);
                  default:
                    return status satisfies never;
                }
              }),
            ),
          );
        }),
      );

      if (options.source !== undefined) {
        return files;
      }

      return Stream.merge(containerConsoleLogs(api, ctx, container, service.name, options), files);
    });
  }).pipe(Stream.withSpan("RuntimeProvider.logs"));
