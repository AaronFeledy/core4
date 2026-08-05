/**
 * Legacy-compatible prerun adapter — publish `cli-<command>-run` lifecycle event.
 *
 * Status: stub.
 */
import type { Hook } from "../metadata.ts";

export const prerunHook: Hook<"prerun"> = async (_options) => {
  // TODO: publish CliCommandRunEvent through EventService.
};
