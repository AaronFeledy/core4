/**
 * CLI runner — invoked from `bin/lando.ts`.
 *
 * This is the *only* place where `@oclif/core`'s top-level `execute`/`run`
 * runs. It is the imperative shell that:
 *   1. Wires OCLIF hooks (init, prerun, postrun, command_not_found).
 *   2. Installs SIGINT/SIGTERM handlers that bridge to `Effect.interrupt`.
 *   3. Hands argv to OCLIF for parsing.
 *   4. OCLIF resolves the command; the command's `run()` calls into Effect
 *      via `LandoCommandBase.runEffect`.
 *
 * Status: stub.
 */
import { execute } from "@oclif/core";

export interface RunCliOptions {
  /** argv (without `process.argv[0..1]`). */
  readonly argv: ReadonlyArray<string>;
  /** `import.meta.url` from the binary entry point. */
  readonly rootUrl: string;
}

/**
 * Run the Lando CLI.
 *
 * TODO: wire up:
 *   - the OCLIF hooks from `./oclif/hooks/`
 *   - SIGINT/SIGTERM → Effect.interrupt
 *   - exit-code translation from tagged errors
 */
export const runCli = async (options: RunCliOptions): Promise<void> => {
  // For now, hand straight to OCLIF. Hooks land via the `oclif` config in
  // `package.json` once they're wired into the manifest pipeline.
  await execute({
    dir: options.rootUrl,
    args: options.argv as Array<string>,
  });
};
