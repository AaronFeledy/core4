/**
 * OCLIF `prerun` hook — publish `cli-<command>-run` lifecycle event.
 *
 * Status: stub.
 */
import type { Hook } from "@oclif/core";

export const prerunHook: Hook<"prerun"> = async (_options) => {
  // TODO: publish CliCommandRunEvent through EventService.
};
