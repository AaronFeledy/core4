/**
 * Resolver for the OpenTUI-backed interactive prompt driver.
 *
 * The rich driver lives in the bundled `@lando/renderer-lando` plugin and is
 * reached only through a lazy dynamic import so OpenTUI never lands on the
 * cold-start static graph (and the compiled `bun build --compile` binary,
 * which has no native OpenTUI assets, degrades to the line-based reader).
 *
 * Resolution returns `undefined` — meaning "use the line-based prompt path" —
 * unless every gate passes: real TTY stdin, not CI, and no `--yes` /
 * `--no-interactive` deterministic override. Any import/probe failure also
 * yields `undefined`, so a missing or broken renderer plugin can never break a
 * command.
 *
 * Lives under `core/src/interaction/` (not `core/src/cli/`) so the default
 * `InteractionServiceLive` can wire it in as its rich-driver seam without a
 * cli→core layering inversion.
 */

import { PromptCancelledError, type PromptDriver } from "../recipes/prompts/driver.ts";

interface RawPromptDriver {
  readonly readRaw: (request: unknown) => Promise<string>;
}

interface RendererPluginModule {
  readonly loadInteractivePromptDriver?: () => Promise<RawPromptDriver>;
}

export interface InteractiveDriverGate {
  readonly isTTY: boolean;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly importRendererPlugin?: () => Promise<RendererPluginModule>;
}

const isCi = (env: NodeJS.ProcessEnv): boolean => {
  const value = env.CI;
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
};

const isCancellation = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "PromptCancelledError";

const adaptDriver = (raw: RawPromptDriver): PromptDriver => ({
  readRaw: async (request) => {
    try {
      return await raw.readRaw(request);
    } catch (cause) {
      if (isCancellation(cause)) {
        throw new PromptCancelledError(cause instanceof Error ? cause.message : undefined);
      }
      throw cause;
    }
  },
});

const RENDERER_PLUGIN_SPECIFIER = "@lando/renderer-lando";

export const resolveInteractivePromptDriver = async (
  gate: InteractiveDriverGate,
): Promise<PromptDriver | undefined> => {
  const env = gate.env ?? process.env;
  if (!gate.isTTY) return undefined;
  if (gate.yes === true) return undefined;
  if (gate.nonInteractive === true) return undefined;
  if (isCi(env)) return undefined;
  if (env.LANDO_NO_OPENTUI_PROMPTS === "1") return undefined;

  try {
    const importPlugin =
      gate.importRendererPlugin ?? (() => import(RENDERER_PLUGIN_SPECIFIER) as Promise<RendererPluginModule>);
    const mod = await importPlugin();
    const loader = mod.loadInteractivePromptDriver;
    if (typeof loader !== "function") return undefined;
    return adaptDriver(await loader());
  } catch {
    return undefined;
  }
};
