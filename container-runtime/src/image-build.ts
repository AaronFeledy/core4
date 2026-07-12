import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/services";

import { type BuildContextEntry, packBuildContext, tarStream, tarText } from "./build-context.ts";

export { buildContextContentDigest, packBuildContext } from "./build-context.ts";

export interface ContainerBuildHttpRequest {
  readonly method: "POST";
  readonly path: `/${string}`;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface ContainerBuildHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ContainerBuildHttpApi {
  readonly request?: (
    request: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError>;
}

export interface ContainerBuildOptions {
  readonly providerId: string;
  readonly api: ContainerBuildHttpApi;
}

interface BuildStep {
  readonly command: string | ReadonlyArray<string>;
}

const isControlCharacterCode = (code: number): boolean => code < 32 || code === 127;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((char) => isControlCharacterCode(char.charCodeAt(0)));

const validateDockerfileToken = (value: string, field: string, providerId: string) =>
  hasControlCharacters(value)
    ? Effect.fail(
        new ProviderInternalError({
          providerId,
          operation: "buildArtifact",
          message: `${field} cannot contain CR, LF, or control characters.`,
        }),
      )
    : Effect.void;

const runInstruction = (step: BuildStep, providerId: string) =>
  typeof step.command === "string"
    ? validateDockerfileToken(step.command, "Build step shell command", providerId).pipe(
        Effect.as(`RUN ${step.command}`),
      )
    : Effect.forEach(
        step.command,
        (part) => validateDockerfileToken(part, "Build step argv token", providerId),
        {
          discard: true,
        },
      ).pipe(Effect.as(`RUN ${JSON.stringify(step.command)}`));

const dockerfileForDerivedBuild = (
  providerId: string,
  baseRef: string,
  steps: ReadonlyArray<BuildStep>,
): Effect.Effect<string, ProviderInternalError> =>
  Effect.gen(function* () {
    yield* validateDockerfileToken(baseRef, "Base image reference", providerId);
    const runs = yield* Effect.forEach(steps, (step) => runInstruction(step, providerId));
    return [`FROM ${baseRef}`, ...runs, ""].join("\n");
  });

const serviceBuildSteps = (service: ServicePlan): ReadonlyArray<BuildStep> => {
  const extension = service.extensions["@lando/core/service-features"];
  if (!isRecord(extension) || !Array.isArray(extension.buildSteps)) return [];
  return extension.buildSteps.flatMap((step): ReadonlyArray<BuildStep> => {
    if (!isRecord(step)) return [];
    if (typeof step.command === "string") return [{ command: step.command }];
    if (!Array.isArray(step.command)) return [];
    const command = step.command.filter((part): part is string => typeof part === "string");
    return command.length === step.command.length ? [{ command }] : [];
  });
};

const deterministicRef = (input: ArtifactBuildSpec): string =>
  `lando-build-${input.plan.provider}-${input.service}-${input.buildKey.slice(0, 24)}`.replace(
    /[^a-zA-Z0-9_.-]/gu,
    "-",
  );

const buildPath = (input: ArtifactBuildSpec, tag: string, derived: boolean): `/${string}` => {
  const params = new URLSearchParams({ t: tag });
  const artifact = input.plan.services[input.service]?.artifact;
  if (!derived && artifact?.kind === "build") {
    params.set("dockerfile", artifact.spec ?? "Dockerfile");
    if (artifact.args !== undefined) params.set("buildargs", JSON.stringify(artifact.args));
    if (artifact.target !== undefined) params.set("target", artifact.target);
  } else {
    params.set("dockerfile", "Dockerfile");
  }
  return `/build?${params.toString()}`;
};

const redactBuildQuery = (value: string): string =>
  value.replace(/(buildargs=)(?:[^&\s]+)/giu, "$1[redacted]");

const sanitizeBuildErrorValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactBuildQuery(value);
  if (Array.isArray(value)) return value.map(sanitizeBuildErrorValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeBuildErrorValue(entry)]),
  );
};

const sanitizeProviderError = (
  cause: ProviderUnavailableError | ProviderInternalError,
): ProviderUnavailableError | ProviderInternalError => {
  const input = {
    providerId: cause.providerId,
    operation: cause.operation,
    message: redactBuildQuery(cause.message),
    details: cause.details === undefined ? undefined : sanitizeBuildErrorValue(cause.details),
    remediation: cause.remediation,
  };
  return cause instanceof ProviderInternalError
    ? new ProviderInternalError(input)
    : new ProviderUnavailableError(input);
};

const requestBuild = (
  request: NonNullable<ContainerBuildHttpApi["request"]>,
  options: ContainerBuildOptions,
  path: `/${string}`,
  stdin: AsyncIterable<Uint8Array>,
): Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  request({
    method: "POST",
    path,
    headers: { "Content-Type": "application/x-tar" },
    stdin,
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
        ? sanitizeProviderError(cause)
        : new ProviderUnavailableError({
            providerId: options.providerId,
            operation: "buildArtifact",
            message: "Container image build request failed.",
            cause,
          }),
    ),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: options.providerId,
              operation: "buildArtifact",
              message: `Container image build failed with HTTP ${response.status}.`,
              details: { status: response.status },
            }),
          ),
    ),
  );

const parseDigest = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && isRecord(parsed.aux) && typeof parsed.aux.Digest === "string")
        return parsed.aux.Digest;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  return undefined;
};

export const buildContainerArtifact = (
  input: ArtifactBuildSpec,
  options: ContainerBuildOptions,
): Effect.Effect<ArtifactRef, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const request = options.api.request;
    if (request === undefined) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `${options.providerId} buildArtifact requires a container API request client.`,
        }),
      );
    }
    const service = input.plan.services[input.service];
    if (service === undefined) {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `Service ${input.service} is not present in the app plan.`,
        }),
      );
    }
    const artifact = service.artifact;
    const steps = serviceBuildSteps(service);
    const tag = deterministicRef(input);
    let response: ContainerBuildHttpResponse;
    if (artifact?.kind === "build") {
      const packed = yield* Effect.tryPromise({
        try: () => packBuildContext(artifact.context),
        catch: (cause) =>
          new ProviderInternalError({
            providerId: options.providerId,
            operation: "buildArtifact",
            message: "Unable to read artifact build context.",
            cause,
          }),
      });
      const baseTag = steps.length === 0 ? tag : `${tag}-base`;
      response = yield* requestBuild(request, options, buildPath(input, baseTag, false), packed.tar);
      if (steps.length > 0) {
        const dockerfile = yield* dockerfileForDerivedBuild(options.providerId, baseTag, steps);
        const entries: ReadonlyArray<BuildContextEntry> = [
          { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
        ];
        response = yield* requestBuild(request, options, buildPath(input, tag, true), tarStream(entries));
      }
    } else if (artifact?.kind === "ref" && steps.length > 0) {
      const dockerfile = yield* dockerfileForDerivedBuild(options.providerId, artifact.ref, steps);
      const entries: ReadonlyArray<BuildContextEntry> = [
        { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
      ];
      response = yield* requestBuild(request, options, buildPath(input, tag, true), tarStream(entries));
    } else {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `Service ${input.service} has no artifact build inputs.`,
        }),
      );
    }
    const digest = parseDigest(response.body);
    return { providerId: input.plan.provider, ref: tag, ...(digest === undefined ? {} : { digest }) };
  });
