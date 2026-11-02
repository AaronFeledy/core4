import { randomBytes } from "node:crypto";

import { Effect, Stream } from "effect";

import { CONTAINER_HELPER_FILE, logFileHelperCleanupArgv } from "./container-helper.ts";
import type { DataPlaneApiClient, DataPlaneHttpRequest } from "./data-plane.ts";
import { ensure2xx, parseExecId, unavailable } from "./log-file-errors.ts";

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

export const makeLogFileHelperPaths = (): LogFileHelperPaths => {
  const directoryName = `${helperDirectoryPrefix}${randomBytes(16).toString("hex")}`;
  return {
    directoryName,
    directoryPath: `/tmp/${directoryName}`,
    helperPath: `/tmp/${directoryName}/${CONTAINER_HELPER_FILE}`,
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
      Cmd: logFileHelperCleanupArgv(paths.helperPath, paths.directoryPath),
      AttachStdin: false,
      // Podman refuses to start a non-detached exec with no attached stream.
      AttachStdout: true,
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
