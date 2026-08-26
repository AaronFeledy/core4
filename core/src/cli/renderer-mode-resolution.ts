/**
 * Effective renderer-mode resolution for the CLI boundary.
 *
 * Resolves the renderer mode from the flag/env precedence in
 * `renderer-selection`, falling back to persisted `config.renderer` /
 * `config.logLevel` from one ConfigService.load when neither a flag nor env
 * selected a mode. The config read is isolated here so the pure selection
 * logic stays IO-free.
 */
import { Effect } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { ConfigServiceLive } from "@lando/engine/services/config";
import type { RendererMode, ResolveRendererModeResult } from "./renderer-selection";
import { resolveRendererMode } from "./renderer-selection";

export type ConfigCliGlobals = {
  readonly renderer?: string;
  readonly logLevel?: string;
};

export type ApplyDebugRendererFlipInput = {
  readonly verbose: boolean;
  readonly renderer: ResolveRendererModeResult;
};

export const applyDebugRendererFlip = (input: ApplyDebugRendererFlipInput): RendererMode =>
  input.verbose && input.renderer.source === "default" ? "verbose" : input.renderer.mode;

export const readConfigCliGlobals = async (): Promise<ConfigCliGlobals> => {
  const config = await Effect.runPromise(
    Effect.flatMap(ConfigService, (service) => service.load).pipe(
      Effect.provide(ConfigServiceLive),
      Effect.catchAll(() => Effect.succeed(undefined)),
    ),
  );
  if (config === undefined) return {};
  return {
    ...(typeof config.renderer === "string" ? { renderer: config.renderer } : {}),
    ...(typeof config.logLevel === "string" ? { logLevel: config.logLevel } : {}),
  };
};

export interface ResolveCliRendererModeOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadConfigRenderer?: () => Promise<string | undefined>;
}

export const resolveCliRendererMode = async (
  options: ResolveCliRendererModeOptions,
): Promise<ResolveRendererModeResult> => {
  const initial = resolveRendererMode({ argv: options.argv, env: options.env });
  if (initial.source === "flag" || initial.source === "env") return initial;
  const loadRenderer = options.loadConfigRenderer ?? (async () => (await readConfigCliGlobals()).renderer);
  const configValue = await loadRenderer();
  if (configValue !== undefined && configValue !== "") {
    return resolveRendererMode({ argv: options.argv, env: options.env, configValue });
  }
  return initial;
};
