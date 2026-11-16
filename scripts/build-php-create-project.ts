#!/usr/bin/env bun
import { resolve } from "node:path";
import { createProjectCommand } from "../core/src/recipes/builtin/create-project.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const root = resolve(import.meta.dirname, "..");

/**
 * The PHP service image installs the shared create-project protocol as
 * `lando-create-project`. The plugin cannot import the recipe tree, so this
 * generator carries the same text into the derived image module; the protocol
 * module in `core/src/recipes/builtin/` stays the only authored source.
 */
export const buildPhpCreateProjectScript = (): string => createProjectCommand();

export const buildPhpCreateProjectModule = (): string =>
  [
    "/**",
    " * **GENERATED FILE** — do not edit by hand.",
    " * Regenerate via bun run codegen:php-create-project.",
    " *",
    " * Source: core/src/recipes/builtin/create-project.ts, which composes the shared",
    " * scaffold protocol. The PHP service image installs this text as",
    " * `/usr/local/bin/lando-create-project`.",
    " */",
    `export const PHP_CREATE_PROJECT_SCRIPT = ${JSON.stringify(buildPhpCreateProjectScript())};`,
    "",
  ].join("\n");

if (import.meta.main) {
  await writeFormattedOutput(
    resolve(root, "plugins/service-lando/src/services/generated/php-create-project.ts"),
    buildPhpCreateProjectModule(),
  );
}
