import { resolve } from "node:path";

import { firstSecretReference } from "@lando/landofile/secret-reference";
import { BuildArgSecretReferenceError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type ArtifactBuildSpec,
  type LandofileShape,
  PortablePath,
  type ServiceConfig,
} from "@lando/sdk/schema";

type BuildBlockShape = NonNullable<ServiceConfig["build"]>;
type ComposeBuildShape = Extract<BuildBlockShape, { readonly context: string }>;

export const isComposeBuild = (build: BuildBlockShape): build is ComposeBuildShape => "context" in build;

export const buildArgSecretReferenceError = (
  service: string,
  arg: string,
  value: string,
): BuildArgSecretReferenceError | undefined => {
  const reference = firstSecretReference(value);
  if (reference === undefined) return undefined;
  return new BuildArgSecretReferenceError({
    message: `Service ${service} build arg ${arg} uses ${reference}. Build args are recorded in image history.`,
    service,
    arg,
    reference,
    remediation:
      "Put the secret in a service environment value as ${secret:...} instead. Secret stores resolve environment at start, not during image build.",
  });
};

export const firstBuildArgSecretReferenceError = (
  service: string,
  args: Readonly<Record<string, string>> | undefined,
): BuildArgSecretReferenceError | undefined => {
  if (args === undefined) return undefined;
  for (const [arg, value] of Object.entries(args)) {
    const error = buildArgSecretReferenceError(service, arg, value);
    if (error !== undefined) return error;
  }
  return undefined;
};

export const buildArgSecretReferenceErrors = (
  landofile: LandofileShape,
): ReadonlyArray<BuildArgSecretReferenceError> => {
  const errors: BuildArgSecretReferenceError[] = [];
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    const build = service.build;
    if (build === undefined || !isComposeBuild(build) || build.args === undefined) continue;
    for (const [arg, value] of Object.entries(build.args)) {
      const error = buildArgSecretReferenceError(name, arg, value);
      if (error !== undefined) errors.push(error);
    }
  }
  return errors;
};

export const composeBuildToArtifact = (build: ComposeBuildShape, appRoot: string): ArtifactBuildSpec => {
  const common = {
    kind: "build" as const,
    context: AbsolutePath.make(resolve(appRoot, build.context)),
    ...(build.args === undefined ? {} : { args: build.args }),
    ...(build.target === undefined ? {} : { target: build.target }),
  };
  return build.dockerfileInline === undefined
    ? {
        ...common,
        ...(build.dockerfile === undefined ? {} : { spec: PortablePath.make(build.dockerfile) }),
      }
    : { ...common, specInline: build.dockerfileInline };
};
