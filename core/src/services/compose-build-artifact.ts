import { resolve } from "node:path";

import {
  AbsolutePath,
  type ArtifactBuildSpec,
  type BuildBlockShape,
  type ComposeBuildShape,
  PortablePath,
} from "@lando/sdk/schema";

export const isComposeBuild = (build: BuildBlockShape): build is ComposeBuildShape => "context" in build;

export const composeBuildToArtifact = (build: ComposeBuildShape, appRoot: string): ArtifactBuildSpec => ({
  kind: "build",
  context: AbsolutePath.make(resolve(appRoot, build.context)),
  ...(build.dockerfile === undefined ? {} : { spec: PortablePath.make(build.dockerfile) }),
  ...(build.dockerfileInline === undefined ? {} : { specInline: build.dockerfileInline }),
  ...(build.args === undefined ? {} : { args: build.args }),
  ...(build.target === undefined ? {} : { target: build.target }),
});
