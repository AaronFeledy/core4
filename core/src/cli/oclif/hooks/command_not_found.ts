/**
 * OCLIF `command_not_found` hook — consult tooling registry first.
 *
 * If the unknown command matches a Landofile `tooling:` entry, the hook
 * loads the cached `ToolingProgram` and dispatches via the active
 * `ToolingEngine`. Otherwise, falls through to OCLIF's default not-found
 * handler (which emits friendly suggestions and exit code 127).
 *
 * Status: stub.
 */
import type { Hook } from "@oclif/core";

export const commandNotFoundHook: Hook<"command_not_found"> = async (_options) => {
  // TODO: look up tooling registry; dispatch via ToolingEngine.
};
