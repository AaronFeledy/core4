if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
    const packageJson: unknown = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    const version =
      typeof packageJson === "object" && packageJson !== null && "version" in packageJson
        ? packageJson.version
        : undefined;

    if (typeof version !== "string") {
      throw new Error("Unable to read @lando/core package version.");
    }

    console.log(version);
    process.exit(0);
  }
}

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

import type { RunCliOptions } from "./run.ts";

// CLI runner used by `bin/lando.ts`.
export type { RunCliOptions } from "./run.ts";

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const cli = await import("./run.ts");
  await cli.runCli(options);
};

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
