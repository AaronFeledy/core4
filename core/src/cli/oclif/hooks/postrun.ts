/**
 * OCLIF `postrun` hook.
 *
 * Bridges OCLIF `postrun` to the Lando event service.
 *
 * Status: stub.
 */
import type { Hook } from "@oclif/core";

export const postrunHook: Hook<"postrun"> = async (_options) => {
  // TODO: publish post-command lifecycle events.
};
