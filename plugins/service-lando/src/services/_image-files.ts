import { Buffer } from "node:buffer";

import type { ServiceBuildStepIntent } from "@lando/sdk/services";

/** A file a Lando-owned build step bakes into a service's derived image. */
export interface LandoBuildFile {
  readonly path: string;
  readonly content: string;
}

const buildFileDirectory = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
};

/**
 * One root build step that writes constant files into the derived image.
 *
 * Each file travels base64-encoded because a derived build renders this step
 * as a Dockerfile `RUN`, and a build-step token carrying CR or LF is refused
 * there. Encoding keeps the written bytes identical to the caller's content
 * without putting a newline in the command.
 */
export const landoImageFilesBuildStep = (
  id: string,
  files: ReadonlyArray<LandoBuildFile>,
): ServiceBuildStepIntent => {
  const directories = [...new Set(files.map((file) => buildFileDirectory(file.path)))];
  return {
    id,
    phase: "build",
    user: "root",
    command: [
      "sh",
      "-c",
      [
        "set -eu",
        ...directories.map((directory) => `mkdir -p ${directory}`),
        ...files.map(
          (file) =>
            `printf '%s' '${Buffer.from(file.content, "utf8").toString("base64")}' | base64 -d > ${file.path}`,
        ),
      ].join("; "),
    ],
  };
};
