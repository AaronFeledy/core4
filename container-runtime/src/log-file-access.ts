import { readFile } from "node:fs/promises";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

import { Effect, Option, type Scope, Stream } from "effect";

import { type ContainerHelperUnavailableError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess, LogFileHandle, LogFileRead, LogFileStat } from "@lando/sdk/log-follow";
import type { ContainerHelperArtifact } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";

import { logFileHelperExecArgv } from "./container-helper.ts";
import type { DataPlaneApiClient, DataPlaneHttpRequest } from "./data-plane.ts";
import { tryParseJson } from "./engine-json.ts";
import { archiveLogFileHelper } from "./log-file-archive.ts";
import { ensure2xx, internal, parseExecId, unavailable } from "./log-file-errors.ts";
import {
  type LogFileHelperPaths,
  cleanupLogFileHelper,
  makeLogFileHelperPaths,
} from "./log-file-helper-cleanup.ts";
import { HelperSession } from "./log-file-session.ts";

const maxReadBytes = 65_536;
const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;

export interface DockerLogFileAccessOptions {
  readonly redactor?: Redactor;
  /** Explicit host env snapshot when building a standalone redactor. Never process.env. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly container: string;
  /** Resolves the static helper for the container's architecture; runs once per acquisition. */
  readonly resolveHelper: Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError>;
}

type HelperObject = object & Record<"ok", unknown>;

const oneChunk = (chunk: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield chunk;
  },
});

const parseUnsignedDecimalBigInt = (
  value: string,
  providerId: string,
  field: string,
): Effect.Effect<bigint, ProviderError> =>
  unsignedDecimalPattern.test(value)
    ? Effect.succeed(BigInt(value))
    : Effect.fail(internal(providerId, `Invalid unsigned decimal helper ${field}.`, value));

const statFrom = (value: unknown, providerId: string): Effect.Effect<LogFileStat, ProviderError> => {
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

const responseStat = (providerId: string, label: string) => (response: HelperObject) =>
  "stat" in response
    ? statFrom(response.stat, providerId)
    : Effect.fail(internal(providerId, `${label} response omitted stat.`, response));

/**
 * Installs the static helper into `/tmp/lando-log-file-helper-<hex>/` once and
 * starts one long-lived helper exec session that serves every stat, open, and
 * read for the scope's lifetime. Closing the scope ends the session and removes
 * the install, including when acquisition is interrupted after the upload.
 */
export const scopedDockerLogFileAccess = (
  options: DockerLogFileAccessOptions,
): Effect.Effect<LogFileAccess<ProviderError>, ProviderError, Scope.Scope> => {
  const providerId = options.providerId;
  const container = encodeURIComponent(options.container);
  const request = (input: DataPlaneHttpRequest) =>
    options.api.request === undefined
      ? Effect.fail(unavailable(providerId, "Provider API request client is missing."))
      : options.api.request(input);
  const stream = (input: DataPlaneHttpRequest) =>
    options.api.stream === undefined
      ? Stream.fail(unavailable(providerId, "Provider API stream client is missing."))
      : options.api.stream(input);

  const helperBytes = options.resolveHelper.pipe(
    Effect.mapError(
      (error) =>
        new ProviderUnavailableError({
          providerId,
          operation: "logFileAccess",
          message: error.message,
          remediation: error.remediation,
          cause: error,
        }),
    ),
    Effect.flatMap((helper) =>
      Effect.tryPromise({
        try: () => readFile(helper.path),
        catch: (cause) => unavailable(providerId, "Could not read the container helper.", helper.path, cause),
      }),
    ),
  );

  const install = Effect.acquireRelease(
    Effect.gen(function* () {
      const bytes = yield* helperBytes;
      const paths = makeLogFileHelperPaths();
      yield* request({
        method: "PUT",
        path: `/containers/${container}/archive?path=/tmp`,
        headers: { "Content-Type": "application/x-tar" },
        stdin: oneChunk(archiveLogFileHelper(bytes, paths.directoryName)),
      }).pipe(Effect.flatMap((response) => ensure2xx(response, providerId, "install helper")));
      return paths;
    }),
    (paths) => cleanupLogFileHelper(options, paths),
  );

  const exitCodeOf = (execId: string) =>
    request({ method: "GET", path: `/exec/${encodeURIComponent(execId)}/json` }).pipe(
      Effect.flatMap((response) => tryParseJson(response.body, (cause) => cause)),
      Effect.map((decoded) =>
        typeof decoded === "object" && decoded !== null && "ExitCode" in decoded
          ? decoded.ExitCode
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const startSession = (paths: LogFileHelperPaths) =>
    Effect.acquireRelease(
      request({
        method: "POST",
        path: `/containers/${container}/exec`,
        body: {
          Cmd: logFileHelperExecArgv(paths.helperPath),
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: false,
          OpenStdin: true,
          Tty: false,
        },
      }).pipe(
        Effect.tap((response) => ensure2xx(response, providerId, "create helper exec")),
        Effect.flatMap((response) => parseExecId(response.body, providerId)),
        Effect.flatMap((id) =>
          Effect.gen(function* () {
            const service = yield* Effect.serviceOption(RedactionService);
            const redactionOptions = {
              sourceEnv: options.sourceEnv,
            };
            const redactor =
              options.redactor ??
              (Option.isSome(service)
                ? yield* service.value.forProfile("secrets", redactionOptions)
                : createStandaloneRedactor("secrets", redactionOptions));
            return new HelperSession(
              providerId,
              (stdin, signal) =>
                stream({
                  method: "POST",
                  path: `/exec/${encodeURIComponent(id)}/start`,
                  headers: { Connection: "Upgrade", Upgrade: "tcp" },
                  body: { Detach: false, Tty: false },
                  stdin,
                  signal,
                }),
              {
                redactor,
                onEndedBeforeResponse: () =>
                  exitCodeOf(id).pipe(
                    Effect.map((exitCode) =>
                      unavailable(
                        providerId,
                        `Log helper ${paths.helperPath} in container ${options.container} exited before responding${exitCode === undefined ? "" : ` (exit code ${String(exitCode)})`}.`,
                        { container: options.container, helper: paths.helperPath, exitCode },
                      ),
                    ),
                  ),
              },
            );
          }),
        ),
      ),
      (session) => session.close(),
    );

  return Effect.gen(function* () {
    const paths = yield* install;
    const session = yield* startSession(paths);
    const send = (command: Readonly<Record<string, string | number>>) =>
      session.send(command).pipe(Effect.flatMap((response) => parseResponse(response, providerId)));
    const handle: LogFileHandle<ProviderError> = {
      stat: send({ op: "fstat" }).pipe(Effect.flatMap(responseStat(providerId, "Fstat"))),
      read: (offset, maxBytes): Effect.Effect<LogFileRead, ProviderError> =>
        send({ op: "read", offset: String(offset), maxBytes: Math.min(maxBytes, maxReadBytes) }).pipe(
          Effect.flatMap((response) => {
            if (!("bytes" in response) || !("nextOffset" in response) || !("eof" in response))
              return Effect.fail(internal(providerId, "Read response omitted fields.", response));
            if (
              typeof response.bytes !== "string" ||
              typeof response.nextOffset !== "string" ||
              typeof response.eof !== "boolean"
            )
              return Effect.fail(internal(providerId, "Read response fields have invalid types.", response));
            const eof = response.eof;
            const bytes = decodeBase64(response.bytes).slice(0, maxBytes);
            return parseUnsignedDecimalBigInt(response.nextOffset, providerId, "read nextOffset").pipe(
              Effect.map((nextOffset) => ({ bytes, nextOffset, eof })),
            );
          }),
        ),
      close: send({ op: "close" }).pipe(Effect.ignore),
    };
    return {
      stat: (path) =>
        send({ op: "stat", path }).pipe(
          Effect.flatMap((response) =>
            "missing" in response && response.missing === true
              ? Effect.succeed(Option.none<LogFileStat>())
              : responseStat(providerId, "Stat")(response).pipe(Effect.map(Option.some)),
          ),
        ),
      open: (path) =>
        send({ op: "open", path }).pipe(Effect.flatMap(responseStat(providerId, "Open")), Effect.as(handle)),
    };
  });
};
