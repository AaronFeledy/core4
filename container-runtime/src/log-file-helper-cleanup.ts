import { randomBytes } from "node:crypto";

import { Effect, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { DataPlaneApiClient, DataPlaneHttpRequest, DataPlaneHttpResponse } from "./data-plane.ts";

const helperDirectoryPrefix = "lando-log-file-helper-";
const helperCleanupTimeout = "1 second";

export interface LogFileHelperPaths {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly helperPath: string;
}

interface LogFileHelperCleanupOptions {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly container: string;
}

const internal = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const unavailable = (providerId: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
  });

const ensure2xx = (response: DataPlaneHttpResponse, providerId: string, details: unknown) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(
        unavailable(providerId, `Docker-compatible API returned HTTP ${response.status}.`, details),
      );

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

export const makeLogFileHelperPaths = (): LogFileHelperPaths => {
  const directoryName = `${helperDirectoryPrefix}${randomBytes(16).toString("hex")}`;
  return {
    directoryName,
    directoryPath: `/tmp/${directoryName}`,
    helperPath: `/tmp/${directoryName}/lando-log-file-helper`,
  };
};

export const cleanupLogFileHelper = (options: LogFileHelperCleanupOptions, paths: LogFileHelperPaths) => {
  const request = (input: DataPlaneHttpRequest) =>
    options.api.request === undefined
      ? Effect.fail(unavailable(options.providerId, "Provider API request client is missing."))
      : options.api.request(input);
  const stream = (input: DataPlaneHttpRequest) =>
    options.api.stream === undefined
      ? Stream.fail(unavailable(options.providerId, "Provider API stream client is missing."))
      : options.api.stream(input);
  return request({
    method: "POST",
    path: `/containers/${encodeURIComponent(options.container)}/exec`,
    body: {
      Cmd: [paths.helperPath, "cleanup", paths.directoryPath],
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      Tty: false,
      User: "0",
    },
  }).pipe(
    Effect.tap((response) => ensure2xx(response, options.providerId, "create cleanup helper exec")),
    Effect.flatMap((response) => parseExecId(response.body, options.providerId)),
    Effect.flatMap((id) =>
      stream({
        method: "POST",
        path: `/exec/${encodeURIComponent(id)}/start`,
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
        body: { Detach: false, Tty: false },
      }).pipe(Stream.runDrain),
    ),
    Effect.timeoutOption(helperCleanupTimeout),
    Effect.ignore,
  );
};
