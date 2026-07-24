import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/services";

import { type BuildContextEntry, packBuildContext, tarStream, tarText } from "./build-context.ts";
import { type ContainerBuildOptions, requestContainerBuild } from "./image-build-http.ts";

export { buildContextContentDigest, packBuildContext } from "./build-context.ts";
export type {
  ContainerBuildHttpApi,
  ContainerBuildHttpRequest,
  ContainerBuildHttpResponse,
  ContainerBuildOptions,
} from "./image-build-http.ts";

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
    let digest: string | undefined;
    const secretValues =
      artifact?.kind === "build" && artifact.args !== undefined ? Object.values(artifact.args) : [];
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
      digest = yield* requestContainerBuild({
        request,
        options,
        path: buildPath(input, baseTag, false),
        tag: baseTag,
        stdin: packed.tar,
        secretValues,
      });
      if (steps.length > 0) {
        const dockerfile = yield* dockerfileForDerivedBuild(options.providerId, baseTag, steps);
        const entries: ReadonlyArray<BuildContextEntry> = [
          { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
        ];
        digest = yield* requestContainerBuild({
          request,
          options,
          path: buildPath(input, tag, true),
          tag,
          stdin: tarStream(entries),
          secretValues,
        });
      }
    } else if (artifact?.kind === "ref" && steps.length > 0) {
      const dockerfile = yield* dockerfileForDerivedBuild(options.providerId, artifact.ref, steps);
      const entries: ReadonlyArray<BuildContextEntry> = [
        { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
      ];
      digest = yield* requestContainerBuild({
        request,
        options,
        path: buildPath(input, tag, true),
        tag,
        stdin: tarStream(entries),
        secretValues,
      });
    } else {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `Service ${input.service} has no artifact build inputs.`,
        }),
      );
    }
    return { providerId: input.plan.provider, ref: tag, ...(digest === undefined ? {} : { digest }) };
  });
