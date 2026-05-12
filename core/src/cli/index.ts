import corePackage from "../../package.json";

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
    const version = corePackage.version;

    if (typeof version !== "string") {
      throw new Error("Unable to read @lando/core package version.");
    }

    console.log(version);
    process.exit(0);
  }

  if (argv.length === 1 && argv[0] === "shellenv") {
    const { fileURLToPath } = await import("node:url");
    const installDir = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");

    console.log(`export LANDO_INSTALL_DIR="${installDir}"`);
    console.log('export PATH="${LANDO_INSTALL_DIR}/bin:${PATH}"');
    process.exit(0);
  }
}

/**
 * `@lando/core/cli` — programmatic CLI runner entry point.
 *
 * **Required behavior** (PRD-02 FR-4): the pre-OCLIF fast path at the top
 * of this file MUST run before any `import` of OCLIF or Effect. ESM hoists
 * static imports/re-exports ahead of the module body, so this file:
 *   - Uses a dynamic `await import("./run.ts")` for the OCLIF runner.
 *   - Contains NO static `export *` re-exports that would transitively pull
 *     in `effect` (the built-in command operations live in
 *     `@lando/core/cli/operations` instead).
 *
 * Two consumers:
 *   1. The `lando` binary (`bin/lando.ts`) imports `runCli` here to wire
 *      OCLIF + the bootstrap. The binary mirrors the same fast path so the
 *      compiled artifact short-circuits before this module is loaded.
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
