import { Effect, Option, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess, LogFileHandle, LogFileRead, LogFileStat } from "@lando/sdk/log-follow";
import type { ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient, DataPlaneHttpRequest, DataPlaneHttpResponse } from "./data-plane.ts";
import { archiveLogFileHelper } from "./log-file-archive.ts";
import { HelperSession } from "./log-file-session.ts";

const helperPath = "/tmp/lando-log-file-helper";
const maxReadBytes = 65_536;

export interface DockerLogFileAccessOptions {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly container: string;
  readonly helperPayload: Uint8Array;
}

type HelperObject = object & Record<"ok", unknown>;

const internal = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const unavailable = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const oneChunk = (chunk: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield chunk;
  },
});

const parseExecId = (body: string, providerId: string) =>
  Effect.try({
    try: () => JSON.parse(body),
    catch: (cause) => internal(providerId, "Docker exec create returned malformed JSON.", body, cause),
  }).pipe(
    Effect.flatMap((decoded) =>
      typeof decoded === "object" && decoded !== null && "Id" in decoded && typeof decoded.Id === "string"
        ? Effect.succeed(decoded.Id)
        : Effect.fail(internal(providerId, "Docker exec create omitted Id.", decoded)),
    ),
  );

const ensure2xx = (response: DataPlaneHttpResponse, providerId: string, details: unknown) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(
        unavailable(providerId, `Docker-compatible API returned HTTP ${response.status}.`, details),
      );

const statFrom = (value: unknown, providerId: string): Effect.Effect<LogFileStat, ProviderInternalError> => {
  if (typeof value !== "object" || value === null)
    return Effect.fail(internal(providerId, "Invalid helper stat frame.", value));
  if (!("dev" in value) || !("ino" in value) || !("size" in value)) {
    return Effect.fail(internal(providerId, "Incomplete helper stat frame.", value));
  }
  return typeof value.dev === "string" && typeof value.ino === "string" && typeof value.size === "string"
    ? Effect.succeed({ dev: value.dev, ino: value.ino, size: BigInt(value.size) })
    : Effect.fail(internal(providerId, "Invalid helper stat field types.", value));
};

const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64"));

const parseResponse = (value: unknown, providerId: string): Effect.Effect<HelperObject, ProviderError> => {
  if (typeof value !== "object" || value === null || !("ok" in value))
    return Effect.fail(internal(providerId, "Invalid helper response frame.", value));
  if (value.ok === false)
    return Effect.fail(unavailable(providerId, "Log helper could not access the file.", value));
  if (value.ok !== true) return Effect.fail(internal(providerId, "Invalid helper response status.", value));
  return Effect.succeed(value);
};

export const makeDockerLogFileAccess = (
  options: DockerLogFileAccessOptions,
): LogFileAccess<ProviderError> => {
  let installed = false;
  const request = (input: DataPlaneHttpRequest) =>
    options.api.request === undefined
      ? Effect.fail(unavailable(options.providerId, "Provider API request client is missing."))
      : options.api.request(input);
  const stream = (input: DataPlaneHttpRequest) =>
    options.api.stream === undefined
      ? Stream.fail(unavailable(options.providerId, "Provider API stream client is missing."))
      : options.api.stream(input);
  const install = () =>
    installed
      ? Effect.void
      : request({
          method: "PUT",
          path: `/containers/${encodeURIComponent(options.container)}/archive?path=/tmp`,
          headers: { "Content-Type": "application/x-tar" },
          stdin: oneChunk(archiveLogFileHelper(options.helperPayload)),
        }).pipe(
          Effect.tap((response) => ensure2xx(response, options.providerId, "install helper")),
          Effect.tap(() =>
            Effect.sync(() => {
              installed = true;
            }),
          ),
          Effect.asVoid,
        );
  const startSession = () =>
    install().pipe(
      Effect.zipRight(
        request({
          method: "POST",
          path: `/containers/${encodeURIComponent(options.container)}/exec`,
          body: {
            Cmd: [helperPath],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: false,
            OpenStdin: true,
            Tty: false,
          },
        }),
      ),
      Effect.tap((response) => ensure2xx(response, options.providerId, "create helper exec")),
      Effect.flatMap((response) => parseExecId(response.body, options.providerId)),
      Effect.map(
        (id) =>
          new HelperSession(options.providerId, (stdin, signal) =>
            stream({
              method: "POST",
              path: `/exec/${encodeURIComponent(id)}/start`,
              headers: { Connection: "Upgrade", Upgrade: "tcp" },
              body: { Detach: false, Tty: false },
              stdin,
              signal,
            }),
          ),
      ),
    );
  const stat = (session: HelperSession, path: string) =>
    session.send({ op: "stat", path }).pipe(
      Effect.flatMap((response) => parseResponse(response, options.providerId)),
      Effect.flatMap((response) =>
        "missing" in response && response.missing === true
          ? Effect.succeed(Option.none<LogFileStat>())
          : "stat" in response
            ? statFrom(response.stat, options.providerId).pipe(Effect.map(Option.some))
            : Effect.fail(internal(options.providerId, "Stat response omitted stat.", response)),
      ),
      Effect.ensuring(session.close()),
    );
  return {
    stat: (path) => startSession().pipe(Effect.flatMap((session) => stat(session, path))),
    open: (path) =>
      startSession().pipe(
        Effect.flatMap((session) =>
          session.send({ op: "open", path }).pipe(
            Effect.flatMap((response) => parseResponse(response, options.providerId)),
            Effect.flatMap((response) =>
              "stat" in response
                ? statFrom(response.stat, options.providerId)
                : Effect.fail(internal(options.providerId, "Open response omitted stat.", response)),
            ),
            Effect.map(
              (): LogFileHandle<ProviderError> => ({
                stat: session.send({ op: "fstat" }).pipe(
                  Effect.flatMap((response) => parseResponse(response, options.providerId)),
                  Effect.flatMap((response) =>
                    "stat" in response
                      ? statFrom(response.stat, options.providerId)
                      : Effect.fail(internal(options.providerId, "Fstat response omitted stat.", response)),
                  ),
                ),
                read: (offset, maxBytes): Effect.Effect<LogFileRead, ProviderError> =>
                  session
                    .send({ op: "read", offset: String(offset), maxBytes: Math.min(maxBytes, maxReadBytes) })
                    .pipe(
                      Effect.flatMap((response) => parseResponse(response, options.providerId)),
                      Effect.flatMap((response) => {
                        if (!("bytes" in response) || !("nextOffset" in response) || !("eof" in response))
                          return Effect.fail(
                            internal(options.providerId, "Read response omitted fields.", response),
                          );
                        if (
                          typeof response.bytes !== "string" ||
                          typeof response.nextOffset !== "string" ||
                          typeof response.eof !== "boolean"
                        )
                          return Effect.fail(
                            internal(
                              options.providerId,
                              "Read response fields have invalid types.",
                              response,
                            ),
                          );
                        const bytes = decodeBase64(response.bytes).slice(0, maxBytes);
                        return Effect.succeed({
                          bytes,
                          nextOffset: BigInt(response.nextOffset),
                          eof: response.eof,
                        });
                      }),
                    ),
                close: Effect.suspend(() => session.close()),
              }),
            ),
            Effect.catchAll((cause) => session.close().pipe(Effect.zipRight(Effect.fail(cause)))),
          ),
        ),
      ),
  };
};
