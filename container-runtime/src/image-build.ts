import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/services";

import { type BuildContextEntry, packBuildContext, tarStream, tarText } from "./build-context.ts";
import { type PreparedBuildStep, copyInstructions, prepareDerivedBuild } from "./image-build-ca.ts";
import { type ContainerBuildOptions, requestContainerBuild } from "./image-build-http.ts";
import { inspectInheritedImageUser } from "./image-build-user.ts";

export { buildContextContentDigest, packBuildContext } from "./build-context.ts";
export type {
  ContainerBuildHttpApi,
  ContainerBuildHttpRequest,
  ContainerBuildHttpResponse,
  ContainerBuildOptions,
} from "./image-build-http.ts";

const INLINE_DOCKERFILE_NAME = ".lando.Dockerfile.inline";

const isControlCharacterCode = (code: number): boolean => code < 32 || code === 127;

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

const runInstruction = (step: PreparedBuildStep, providerId: string) =>
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

type DerivedDockerfileInput = {
  readonly providerId: string;
  readonly baseRef: string;
  readonly steps: ReadonlyArray<PreparedBuildStep>;
  readonly inheritedUser: string | undefined;
};

const dockerfileForDerivedBuild = (
  input: DerivedDockerfileInput,
): Effect.Effect<string, ProviderInternalError> =>
  Effect.gen(function* () {
    yield* validateDockerfileToken(input.baseRef, "Base image reference", input.providerId);
    if (input.inheritedUser !== undefined) {
      yield* validateDockerfileToken(input.inheritedUser, "Inherited image user", input.providerId);
    }
    const instructions = yield* Effect.forEach(input.steps, (step) =>
      runInstruction(step, input.providerId).pipe(
        Effect.map((run) => {
          const stepInstructions = [...copyInstructions(step), run];
          return step.privileged && input.inheritedUser !== undefined
            ? ["USER root", ...stepInstructions, `USER ${input.inheritedUser}`]
            : stepInstructions;
        }),
      ),
    );
    return [`FROM ${input.baseRef}`, ...instructions.flat(), ""].join("\n");
  });

const deterministicRef = (input: ArtifactBuildSpec): string =>
  `lando-build-${input.plan.provider}-${input.service}-${input.buildKey.slice(0, 24)}`.replace(
    /[^a-zA-Z0-9_.-]/gu,
    "-",
  );

const resolvedBaseRef = (artifact: Extract<ServicePlan["artifact"], { readonly kind: "ref" }>): string =>
  artifact.digest === undefined || artifact.ref.includes("@")
    ? artifact.ref
    : `${artifact.ref}@${artifact.digest}`;

const buildPath = (input: ArtifactBuildSpec, tag: string, derived: boolean): `/${string}` => {
  const params = new URLSearchParams({ t: tag });
  const artifact = input.plan.services[input.service]?.artifact;
  if (!derived && artifact?.kind === "build") {
    params.set(
      "dockerfile",
      artifact.specInline !== undefined ? INLINE_DOCKERFILE_NAME : (artifact.spec ?? "Dockerfile"),
    );
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
    const { steps, caEntries } = yield* prepareDerivedBuild(service, options.providerId);
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
      const stdin =
        artifact.specInline === undefined
          ? packed.tar
          : tarStream([
              ...packed.entries.filter((entry) => entry.name !== INLINE_DOCKERFILE_NAME),
              {
                kind: "file",
                name: INLINE_DOCKERFILE_NAME,
                mode: 0o644,
                content: tarText(artifact.specInline),
              },
            ]);
      const baseTag = steps.length === 0 ? tag : `${tag}-base`;
      digest = yield* requestContainerBuild({
        request,
        options,
        path: buildPath(input, baseTag, false),
        tag: baseTag,
        stdin,
        secretValues,
      });
      if (steps.length > 0) {
        const inheritedUser = steps.some((step) => step.privileged)
          ? yield* inspectInheritedImageUser({ baseRef: baseTag, providerId: options.providerId, request })
          : undefined;
        const dockerfile = yield* dockerfileForDerivedBuild({
          providerId: options.providerId,
          baseRef: baseTag,
          steps,
          inheritedUser,
        });
        const entries: ReadonlyArray<BuildContextEntry> = [
          { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
          ...caEntries,
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
      const resolvedRef = resolvedBaseRef(artifact);
      const hasPrivilegedStep = steps.some((step) => step.privileged);
      const baseRef = hasPrivilegedStep ? `${tag}-base` : resolvedRef;
      if (hasPrivilegedStep) {
        const baseDockerfile = yield* dockerfileForDerivedBuild({
          providerId: options.providerId,
          baseRef: resolvedRef,
          steps: [],
          inheritedUser: undefined,
        });
        yield* requestContainerBuild({
          request,
          options,
          path: buildPath(input, baseRef, true),
          tag: baseRef,
          stdin: tarStream([
            { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(baseDockerfile) },
          ]),
          secretValues,
        });
      }
      const inheritedUser = hasPrivilegedStep
        ? yield* inspectInheritedImageUser({ baseRef, providerId: options.providerId, request })
        : undefined;
      const dockerfile = yield* dockerfileForDerivedBuild({
        providerId: options.providerId,
        baseRef,
        steps,
        inheritedUser,
      });
      const entries: ReadonlyArray<BuildContextEntry> = [
        { kind: "file", name: "Dockerfile", mode: 0o644, content: tarText(dockerfile) },
        ...caEntries,
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
