#!/usr/bin/env bun
/**
 * Lando v4 CLI entry point.
 *
 * This is the imperative shell consumed by `bun build --compile` to produce
 * the single-binary release artifact. It MUST stay tiny — the only
 * responsibility here is to hand control to the OCLIF adapter inside
 * `@lando/core/cli`, which then bridges into the Effect runtime.
 *
 * Notes:
 * - Compiled-binary constraints forbid dynamic `import()` of arbitrary paths
 *   at runtime. Bundled plugins are statically imported via the generated
 *   `src/plugins/bundled.ts`. User-installed plugins load from disk outside
 *   the binary using Bun's runtime loader.
 * - SIGINT handling and bridge-to-Effect-interrupt happen inside
 *   `@lando/core/cli`. This file does not install signal handlers directly.
 */

import { CORE_VERSION } from "../src/version.ts";

const argv = Bun.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
  console.log(CORE_VERSION);
  process.exit(0);
}

if (argv.length === 1 && argv[0] === "shellenv") {
  const { renderShellenv } = await import("../src/cli/commands/shellenv.ts");
  console.log(renderShellenv("posix"));
  process.exit(0);
}

const { runCli } = await import("@lando/core/cli");

await runCli({
  argv,
  // Hand the import.meta URL to OCLIF so it can resolve the package root.
  rootUrl: import.meta.url,
});
