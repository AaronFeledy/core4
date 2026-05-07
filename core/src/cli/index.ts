/**
 * `@lando/core/cli` — programmatic CLI entry point.
 *
 * This entry MAY pull `@oclif/core` (it is the programmatic-CLI surface).
 * The default `@lando/core` entry MUST NOT.
 *
 * Two consumers:
 *   1. The `lando` binary (`bin/lando.ts`) imports `runCli` here to wire
 *      OCLIF + the bootstrap.
 *   2. Embedding hosts import the built-in command operations
 *      (`startApp`, `stopApp`, `infoApp`, etc.) to invoke the same Effect
 *      programs the CLI runs, without parsing argv or pulling OCLIF into
 *      the host bundle.
 *
 * **Required behaviors**:
 * - Every built-in command has a corresponding exported Effect-returning
 *   function. Input is an Effect-Schema-validated subset of the command's
 *   flags/args; output is a typed result.
 * - Functions DO NOT touch `process.stdin/stdout/stderr` and DO NOT call
 *   OCLIF. Output is in the return value; logs go through the active
 *   `Logger`; rendering is the host's choice.
 * - Functions inherit the runtime's services via the requirements channel.
 * - The compiled `lando` binary uses these same functions internally.
 */

// CLI runner used by `bin/lando.ts`.
export { runCli, type RunCliOptions } from "./run.ts";

// Built-in command operations.
export * from "./commands/start.ts";
export * from "./commands/stop.ts";
export * from "./commands/info.ts";
export * from "./commands/destroy.ts";
export * from "./commands/list.ts";
export * from "./commands/logs.ts";
export * from "./commands/exec.ts";
export * from "./commands/rebuild.ts";
export * from "./commands/restart.ts";
export * from "./commands/poweroff.ts";
export * from "./commands/config.ts";
export * from "./commands/version.ts";
export * from "./commands/update.ts";
export * from "./commands/tooling.ts";
