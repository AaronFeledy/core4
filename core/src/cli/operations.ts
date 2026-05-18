/**
 * `@lando/core/cli/operations` — embedding-host command surface.
 *
 * Re-exports the built-in command operations (`startApp`, `stopApp`,
 * `infoApp`, …) so embedding hosts can invoke the same Effect programs the
 * CLI runs, without parsing argv or pulling OCLIF into the host bundle.
 *
 * **Why this file exists** (PRD-02 FR-4):
 * - `core/src/cli/index.ts` MUST keep the pre-OCLIF fast path at the top
 *   *before any import of OCLIF or Effect*. ESM hoists static `export *`
 *   declarations ahead of the module body, so any command module that
 *   statically imports Effect (e.g. `commands/version.ts`) would be loaded
 *   eagerly when running `bun run core/src/cli/index.ts --version`.
 * - Moving the static re-exports here keeps `index.ts` Effect-free on the
 *   fast path while preserving the embedding-host API at a stable subpath:
 *   `import { startApp } from "@lando/core/cli/operations"`.
 *
 * **Required behaviors** (inherited from each command module):
 * - Every built-in command has a corresponding exported Effect-returning
 *   function. Input is an Effect-Schema-validated subset of the command's
 *   flags/args; output is a typed result.
 * - Functions DO NOT touch `process.stdin/stdout/stderr` and DO NOT call
 *   OCLIF. Output is in the return value; logs go through the active
 *   `Logger`; rendering is the host's choice.
 * - Functions inherit the runtime's services via the requirements channel.
 * - The compiled `lando` binary uses these same functions internally.
 */

export * from "./commands/start.ts";
export * from "./commands/stop.ts";
export * from "./commands/info.ts";
export * from "./commands/destroy.ts";
export * from "./commands/list.ts";
export * from "./commands/logs.ts";
export * from "./commands/exec.ts";
export * from "./commands/shell.ts";
export * from "./commands/rebuild.ts";
export * from "./commands/restart.ts";
export * from "./commands/poweroff.ts";
export * from "./commands/config.ts";
export * from "./commands/version.ts";
export * from "./commands/update.ts";
export * from "./commands/tooling.ts";
