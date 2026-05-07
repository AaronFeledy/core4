/**
 * `@lando/core/oclif` — OCLIF adapter.
 *
 * This entry point is **internal**. It is exported only because the OCLIF
 * compiled-binary build needs it; embedding hosts MUST NOT import it. The
 * default `@lando/core` entry point (and `@lando/core/cli`) MUST NOT pull
 * `@oclif/core` into the import graph. Tests under `test/library/` enforce
 * this boundary.
 *
 * **OCLIF is consumed in *one place only*:** `src/cli/oclif/`. Outside this
 * directory, no module imports `@oclif/core`.
 */

export { LandoCommandBase } from "./command-base.ts";
export { initHook } from "./hooks/init.ts";
export { prerunHook } from "./hooks/prerun.ts";
export { postrunHook } from "./hooks/postrun.ts";
export { commandNotFoundHook } from "./hooks/command_not_found.ts";
