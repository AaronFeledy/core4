import { Effect, Option, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess, LogFileHandle, LogFileRead, LogFileStat } from "@lando/sdk/log-follow";
import type { ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient, DataPlaneHttpRequest, DataPlaneHttpResponse } from "./data-plane.ts";
import { archiveLogFileHelper } from "./log-file-archive.ts";
import { cleanupLogFileHelper, makeLogFileHelperPaths } from "./log-file-helper-cleanup.ts";
import { HelperSession } from "./log-file-session.ts";

const maxReadBytes = 65_536;
const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;

export interface DockerLogFileAccessOptions {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly container: string;
  readonly helperPayload: Uint8Array;
}

type HelperObject = object & Record<"ok", unknown>;

interface HelperLease {
  readonly session: HelperSession;
  readonly close: Effect.Effect<void>;
}

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

const parseUnsignedDecimalBigInt = (
  value: string,
  providerId: string,
  field: string,
): Effect.Effect<bigint, ProviderInternalError> =>
  unsignedDecimalPattern.test(value)
    ? Effect.succeed(BigInt(value))
    : Effect.fail(internal(providerId, `Invalid unsigned decimal helper ${field}.`, value));

const statFrom = (value: unknown, providerId: string): Effect.Effect<LogFileStat, ProviderInternalError> => {
  if (typeof value !== "object" || value === null)
    return Effect.fail(internal(providerId, "Invalid helper stat frame.", value));
  if (!("dev" in value) || !("ino" in value) || !("size" in value)) {
    return Effect.fail(internal(providerId, "Incomplete helper stat frame.", value));
  }
  if (typeof value.dev !== "string" || typeof value.ino !== "string" || typeof value.size !== "string") {
    return Effect.fail(internal(providerId, "Invalid helper stat field types.", value));
  }
  const dev = value.dev;
  const ino = value.ino;
  return parseUnsignedDecimalBigInt(value.size, providerId, "stat size").pipe(
    Effect.map((size) => ({ dev, ino, size })),
  );
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
  const request = (input: DataPlaneHttpRequest) =>
    options.api.request === undefined
      ? Effect.fail(unavailable(options.providerId, "Provider API request client is missing."))
      : options.api.request(input);
  const stream = (input: DataPlaneHttpRequest) =>
    options.api.stream === undefined
      ? Stream.fail(unavailable(options.providerId, "Provider API stream client is missing."))
      : options.api.stream(input);
  const install = (directoryName: string) =>
    request({
      method: "PUT",
      path: `/containers/${encodeURIComponent(options.container)}/archive?path=/tmp`,
      headers: { "Content-Type": "application/x-tar" },
      stdin: oneChunk(archiveLogFileHelper(options.helperPayload, directoryName)),
    }).pipe(
      Effect.tap((response) => ensure2xx(response, options.providerId, "install helper")),
      Effect.asVoid,
    );
  const cleanup = (paths: ReturnType<typeof makeLogFileHelperPaths>) => cleanupLogFileHelper(options, paths);
  const startSession = () =>
    Effect.sync(makeLogFileHelperPaths).pipe(
      Effect.flatMap((paths) =>
        install(paths.directoryName).pipe(
          Effect.zipRight(
            request({
              method: "POST",
              path: `/containers/${encodeURIComponent(options.container)}/exec`,
              body: {
                Cmd: [paths.helperPath],
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
          Effect.map((id): HelperLease => {
            const session = new HelperSession(options.providerId, (stdin, signal) =>
              stream({
                method: "POST",
                path: `/exec/${encodeURIComponent(id)}/start`,
                headers: { Connection: "Upgrade", Upgrade: "tcp" },
                body: { Detach: false, Tty: false },
                stdin,
                signal,
              }),
            );
            let closed = false;
            const close = Effect.suspend(() => {
              if (closed) return Effect.void;
              closed = true;
              return session.close().pipe(Effect.zipRight(cleanup(paths)));
            });
            return { session, close };
          }),
          Effect.catchAll((cause) => cleanup(paths).pipe(Effect.zipRight(Effect.fail(cause)))),
        ),
      ),
    );
  const stat = (lease: HelperLease, path: string) =>
    lease.session.send({ op: "stat", path }).pipe(
      Effect.flatMap((response) => parseResponse(response, options.providerId)),
      Effect.flatMap((response) =>
        "missing" in response && response.missing === true
          ? Effect.succeed(Option.none<LogFileStat>())
          : "stat" in response
            ? statFrom(response.stat, options.providerId).pipe(Effect.map(Option.some))
            : Effect.fail(internal(options.providerId, "Stat response omitted stat.", response)),
      ),
      Effect.ensuring(lease.close),
    );
  return {
    stat: (path) => startSession().pipe(Effect.flatMap((lease) => stat(lease, path))),
    open: (path) =>
      startSession().pipe(
        Effect.flatMap((lease) =>
          lease.session.send({ op: "open", path }).pipe(
            Effect.flatMap((response) => parseResponse(response, options.providerId)),
            Effect.flatMap((response) =>
              "stat" in response
                ? statFrom(response.stat, options.providerId)
                : Effect.fail(internal(options.providerId, "Open response omitted stat.", response)),
            ),
            Effect.map(
              (): LogFileHandle<ProviderError> => ({
                stat: lease.session.send({ op: "fstat" }).pipe(
                  Effect.flatMap((response) => parseResponse(response, options.providerId)),
                  Effect.flatMap((response) =>
                    "stat" in response
                      ? statFrom(response.stat, options.providerId)
                      : Effect.fail(internal(options.providerId, "Fstat response omitted stat.", response)),
                  ),
                ),
                read: (offset, maxBytes): Effect.Effect<LogFileRead, ProviderError> =>
                  lease.session
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
                        const eof = response.eof;
                        const bytes = decodeBase64(response.bytes).slice(0, maxBytes);
                        return parseUnsignedDecimalBigInt(
                          response.nextOffset,
                          options.providerId,
                          "read nextOffset",
                        ).pipe(Effect.map((nextOffset) => ({ bytes, nextOffset, eof })));
                      }),
                    ),
                close: lease.close,
              }),
            ),
            Effect.catchAll((cause) => lease.close.pipe(Effect.zipRight(Effect.fail(cause)))),
          ),
        ),
      ),
  };
};
