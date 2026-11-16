import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import { PHP_CREATE_PROJECT_SCRIPT } from "./generated/php-create-project.ts";

export { PHP_CREATE_PROJECT_SCRIPT };

export const PHP_CREATE_PROJECT_STEP_ID = "service-lando.php:create-project" as const;

/** The generated script lives on the image PATH, so recipes only name the task. */
export const PHP_CREATE_PROJECT_PATH = "/usr/local/bin/lando-create-project";

/** POSIX single-quote a word, escaping embedded quotes, so a build command carries bytes verbatim. */
const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Write the script as one `printf` payload: build commands cannot contain line
 * breaks, so the generated lines travel as quoted words and the trailing
 * newline is restored by the format.
 */
export const phpCreateProjectCommand = (
  content: string = PHP_CREATE_PROJECT_SCRIPT,
  path: string = PHP_CREATE_PROJECT_PATH,
): string =>
  [
    "set -eu",
    `printf '%s\\n' ${content.replace(/\n$/u, "").split("\n").map(shellWord).join(" ")} > ${path}`,
    `chmod 0755 ${path}`,
  ].join(" && ");

/**
 * Install `lando-create-project` into the derived PHP image. The content rides
 * in the command and the build key, so editing the protocol rebuilds the image
 * instead of reusing one that still carries the old script. The file is world
 * readable and executable because tooling may run as the site's non-root user.
 */
export const phpCreateProjectBuildStep = (): ServiceBuildStepIntent => ({
  id: PHP_CREATE_PROJECT_STEP_ID,
  phase: "build",
  command: phpCreateProjectCommand(),
  user: "root",
  buildKeyInputs: {
    createProject: { path: PHP_CREATE_PROJECT_PATH, content: PHP_CREATE_PROJECT_SCRIPT },
  },
});
