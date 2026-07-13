import type { Hook } from "@oclif/core";

import { routeDynamicTooling } from "../../cli-adapters/app-lifecycle.ts";
import {
  setActiveDeprecationWarnings,
  setActiveRendererMode,
  setActiveResultFormat,
} from "../../compiled-runtime.ts";
import { resolveResultFormat } from "../../format-flags.ts";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "../../renderer-boundary.ts";

const normalizeToolingArgv = async (argv: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const renderer = await resolveCliRendererMode({ argv, env: process.env });
  setActiveRendererMode(renderer.mode);
  const deprecations = resolveCliDeprecationWarnings({
    argv: renderer.remainingArgv,
    env: process.env,
  });
  setActiveDeprecationWarnings(deprecations.enabled);
  const format = resolveResultFormat({
    argv: deprecations.remainingArgv,
    rendererMode: renderer.mode,
  });
  setActiveResultFormat(format.format);
  return format.remainingArgv;
};

export const commandNotFoundHook: Hook<"command_not_found"> = async ({ argv = [], context, id }) => {
  const normalizedArgv = await normalizeToolingArgv(argv);
  if (await routeDynamicTooling([id, ...normalizedArgv])) return;
  context.error(`command ${id} not found`, { code: "COMMAND_NOT_FOUND", exit: 2 });
};
