import { resolve } from "node:path";

import { AbsolutePath, type ArtifactBuildSpec, PortablePath, type ServiceConfig } from "@lando/sdk/schema";

type BuildBlockShape = NonNullable<ServiceConfig["build"]>;
type ComposeBuildShape = Extract<BuildBlockShape, { readonly context: string }>;

export const isComposeBuild = (build: BuildBlockShape): build is ComposeBuildShape => "context" in build;

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
