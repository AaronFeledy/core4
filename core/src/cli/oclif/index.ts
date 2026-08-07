/**
 * `core/src/cli/oclif` — legacy-named native metadata and compatibility adapters.
 *
 * This directory has no published package export. The default `@lando/core`
 * entry point (and `@lando/core/cli`) MUST NOT pull development-only CLI
 * tooling into the import graph. Tests under `test/library/` enforce this boundary.
 *
 * This directory is not a shipping engine. The native command registry imports
 * its framework-free metadata and adapters directly.
 */

export { LandoCommandBase } from "./command-base";
export { initHook } from "./hooks/init";
export { prerunHook } from "./hooks/prerun";
export { postrunHook } from "./hooks/postrun";
export { commandNotFoundHook } from "./hooks/command_not_found";
