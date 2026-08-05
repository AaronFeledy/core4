/**
 * `core/src/cli/oclif` — internal OCLIF adapter.
 *
 * This directory has no published package export. The default `@lando/core`
 * entry point (and `@lando/core/cli`) MUST NOT pull `@oclif/core` into the
 * import graph. Tests under `test/library/` enforce this boundary.
 *
 * **OCLIF is consumed in *one place only*:** `src/cli/oclif/`. Outside this
 * directory, no module imports `@oclif/core`.
 */

export { LandoCommandBase } from "./command-base.ts";
export { initHook } from "./hooks/init.ts";
export { prerunHook } from "./hooks/prerun.ts";
export { postrunHook } from "./hooks/postrun.ts";
export { commandNotFoundHook } from "./hooks/command_not_found.ts";
