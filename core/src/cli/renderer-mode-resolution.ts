/**
 * Effective renderer-mode resolution for the CLI boundary.
 *
 * Resolves the renderer mode from the flag/env precedence in
 * `renderer-selection`, falling back to the persisted `config.renderer` value
 * only when neither a flag nor env selected a mode. The config read is isolated
 * here so the pure selection logic stays IO-free.
 */
import { Effect } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { ConfigServiceLive } from "../services/config.ts";
import { type ResolveRendererModeResult, resolveRendererMode } from "./renderer-selection.ts";

export const readConfigRendererValue = async (): Promise<string | undefined> => {
  const value = await Effect.runPromise(
    Effect.flatMap(ConfigService, (config) => config.load).pipe(
      Effect.map((config) => config.renderer),
      Effect.provide(ConfigServiceLive),
      Effect.catchAll(() => Effect.succeed(undefined)),
    ),
  );
  return typeof value === "string" ? value : undefined;
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
  const configValue = await (options.loadConfigRenderer ?? readConfigRendererValue)();
  if (configValue !== undefined && configValue !== "") {
    return resolveRendererMode({ argv: options.argv, env: options.env, configValue });
  }
  return initial;
};
