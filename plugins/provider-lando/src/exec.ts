import { Effect, Stream } from "effect";

import {
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  ServiceNotFoundError,
} from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecResult, ExecTarget, ProviderError } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";

const PROVIDER_ID = "lando";
const textDecoder = new TextDecoder();

type ExecError = ProviderUnavailableError | ProviderInternalError | ServiceExecError | ServiceNotFoundError;

interface ExecCreateResponse {
  readonly Id?: string;
}

interface ExecInspectResponse {
  readonly ExitCode?: number | null;
}

export interface ExecOptions {
  readonly podmanApi?: PodmanApiClient;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const missingApi = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "exec",
    message: "provider-lando exec requires a Podman API client.",
  });

const missingService = (target: ExecTarget) =>
  new ServiceNotFoundError({
    providerId: PROVIDER_ID,
    operation: "exec",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const execFailure = (service: ServicePlan, message: string, details?: unknown) =>
  new ServiceExecError({
    providerId: PROVIDER_ID,
    operation: "exec",
    service: service.name,
    message,
    ...(details === undefined ? {} : { details }),
  });

const request = (
  api: PodmanApiClient,
  input: PodmanHttpRequest,
): Effect.Effect<PodmanHttpResponse, ExecError> =>
  api.request === undefined ? Effect.fail(missingApi()) : api.request(input);

const stream = (api: PodmanApiClient, input: PodmanHttpRequest): Stream.Stream<Uint8Array, ExecError> =>
  api.stream === undefined ? Stream.fail(missingApi()) : api.stream(input);

const parseJson = (
  response: PodmanHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: PROVIDER_ID,
        operation,
        message: "Podman API returned invalid JSON.",
        cause,
      }),
  });

const createExec = (
  plan: AppPlan,
  service: ServicePlan,
  command: CommandSpec,
  api: PodmanApiClient,
): Effect.Effect<string, ExecError> =>
  Effect.gen(function* () {
    const response = yield* request(api, {
      method: "POST",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/exec`,
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: command.command,
        Tty: false,
        ...(command.cwd === undefined ? {} : { WorkingDir: command.cwd }),
        ...(command.env === undefined
          ? {}
          : { Env: Object.entries(command.env).map(([key, value]) => `${key}=${value}`) }),
      },
    });

    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(execFailure(service, "Podman failed to create an exec session.", response));
    }

    const decoded = (yield* parseJson(response, "exec.create")) as ExecCreateResponse;
    const execId = decoded.Id;
    if (typeof execId !== "string" || execId.length === 0) {
      yield* Effect.fail(
        execFailure(service, "Podman exec create response did not include an exec id.", response),
      );
      return "";
    }

    return execId;
  });

const inspectExec = (
  api: PodmanApiClient,
  service: ServicePlan,
  execId: string,
): Effect.Effect<number, ExecError> =>
  Effect.gen(function* () {
    const response = yield* request(api, { method: "GET", path: `/exec/${encodeURIComponent(execId)}/json` });
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(execFailure(service, "Podman failed to inspect an exec session.", response));
    }

    const decoded = (yield* parseJson(response, "exec.inspect")) as ExecInspectResponse;
    const exitCode = decoded.ExitCode;
    if (typeof exitCode !== "number") {
      yield* Effect.fail(
        execFailure(service, "Podman exec inspect response did not include an exit code.", response),
      );
      return 1;
    }

    return exitCode;
  });

const makeAttachDecoder = () => {
  let buffer = new Uint8Array(0);

  return (chunk: Uint8Array): ReadonlyArray<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>> => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;

    const decoded: Array<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>> = [];
    while (buffer.length >= 8) {
      const streamType = buffer[0] ?? 0;
      const frameLength =
        (((buffer[4] ?? 0) << 24) | ((buffer[5] ?? 0) << 16) | ((buffer[6] ?? 0) << 8) | (buffer[7] ?? 0)) >>>
        0;
      if (buffer.length < 8 + frameLength) {
        break;
      }

      const payload = buffer.slice(8, 8 + frameLength);
      buffer = buffer.slice(8 + frameLength);

      if (streamType === 1 || streamType === 2) {
        decoded.push({ kind: streamType === 1 ? "stdout" : "stderr", chunk: payload });
      }
    }

    return decoded;
  };
};

export const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions = {},
): Stream.Stream<ExecChunk, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService(target));
  }
  if (options.podmanApi === undefined) {
    return Stream.fail(missingApi());
  }

  const api = options.podmanApi;

  return Stream.fromEffect(createExec(plan, service, command, api)).pipe(
    Stream.flatMap((execId) => {
      const decodeChunk = makeAttachDecoder();
      const start = stream(api, {
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        body: { Detach: false, Tty: false },
      }).pipe(
        Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))),
        Stream.concat(
          Stream.fromEffect(inspectExec(api, service, execId).pipe(Effect.map((exitCode) => ({ exitCode })))),
        ),
      );

      return start;
    }),
  );
};

export const exec = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions = {},
): Effect.Effect<ExecResult, ProviderError> =>
  execStream(plan, target, command, options).pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for (const chunk of chunks) {
        if ("exitCode" in chunk) {
          exitCode = chunk.exitCode;
        } else if (chunk.kind === "stdout") {
          stdout += textDecoder.decode(chunk.chunk);
        } else {
          stderr += textDecoder.decode(chunk.chunk);
        }
      }

      return { exitCode, stdout, stderr };
    }),
  );
