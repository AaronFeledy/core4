/**
 * Effective renderer-mode resolution for the CLI boundary.
 *
 * Resolves the renderer mode from the flag/env precedence in
 * `renderer-selection`, falling back to persisted `config.renderer` /
 * `config.logLevel` from the Effect-free source stack when neither a flag nor env
 * selected a mode. The config read is isolated here so the pure selection
 * logic stays IO-free.
 */
import { configRecord, mergeGlobalConfigSources, readGlobalConfigSources } from "@lando/paths/config-sources";

import type { GlobalConfig } from "@lando/sdk/schema";

import type { RendererMode, ResolveRendererModeResult } from "./renderer-selection";
import { resolveRendererMode } from "./renderer-selection";

export type ConfigCliGlobals = {
  readonly renderer?: string;
  readonly logLevel?: string;
  readonly tracing?: GlobalConfig["tracing"];
};

export type ApplyDebugRendererFlipInput = {
  readonly verbose: boolean;
  readonly renderer: ResolveRendererModeResult;
};

export const applyDebugRendererFlip = (input: ApplyDebugRendererFlipInput): RendererMode =>
  input.verbose && input.renderer.source === "default" ? "verbose" : input.renderer.mode;

export const readConfigCliGlobals = async (): Promise<ConfigCliGlobals> => {
  const config = mergeGlobalConfigSources(
    readGlobalConfigSources({ env: process.env, sources: { user: true, env: true } }),
  ).tree;
  const tracing = config.tracing;
  const otlp = configRecord(tracing) ? tracing.otlp : undefined;
  const headers =
    configRecord(otlp) && configRecord(otlp.headers)
      ? Object.fromEntries(
          Object.entries(otlp.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    ...(typeof config.renderer === "string" ? { renderer: config.renderer } : {}),
    ...(typeof config.logLevel === "string" ? { logLevel: config.logLevel } : {}),
    ...(configRecord(otlp)
      ? {
          tracing: {
            otlp: {
              ...(typeof otlp.endpoint === "string" ? { endpoint: otlp.endpoint } : {}),
              ...(headers === undefined ? {} : { headers }),
            },
          },
        }
      : {}),
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
