/**
 * Legacy-compatible postrun adapter.
 *
 * Bridges postrun compatibility metadata to the Lando event service.
 *
 * Status: stub.
 */
import type { Hook } from "../metadata";

export const postrunHook: Hook<"postrun"> = async (_options) => {
  // TODO: publish post-command lifecycle events.
};
