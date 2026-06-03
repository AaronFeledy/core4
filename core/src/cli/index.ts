/**
 * `@lando/core/cli` — programmatic CLI runner entry point.
 *
 * **Required behavior** (PRD-02 FR-4): this module must not statically import
 * OCLIF or Effect. ESM hoists static imports/re-exports ahead of the module
 * body, so this file:
 *   - Uses a dynamic `await import("./run.ts")` for the OCLIF runner.
 *   - Contains NO static `export *` re-exports that would transitively pull
 *     in `effect` (the built-in command operations live in
 *     `@lando/core/cli/operations` instead).
 *
 * The pre-OCLIF version/shellenv fast path lives only in the binary entry
 * (`bin/lando.ts`), which is the package `bin` and the `bun build --compile`
 * target; it short-circuits before this module is ever loaded.
 *
 * Two consumers:
 *   1. The `lando` binary (`bin/lando.ts`) imports `runCli` here to wire
 *      OCLIF + the bootstrap.
 *   2. Embedding hosts that want to invoke built-in command operations
 *      (`startApp`, `stopApp`, `infoApp`, …) without parsing argv or
 *      pulling OCLIF into the host bundle import from
 *      `@lando/core/cli/operations`.
 */

import type { RunCliOptions } from "./run.ts";

export type { RunCliOptions } from "./run.ts";

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const cli = await import("./run.ts");
  await cli.runCli(options);
};
