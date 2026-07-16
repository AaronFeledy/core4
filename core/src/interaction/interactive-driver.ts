/**
 * Resolver for the OpenTUI-backed interactive prompt driver.
 *
 * The rich driver lives in the bundled `@lando/renderer-lando` plugin and is
 * reached only through a lazy dynamic import so OpenTUI never lands on the
 * cold-start static graph. Compiled binaries package the target OpenTUI native
 * assets, while loading or probing failures still degrade to the line reader.
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
  readonly debug?: (message: string, data: Readonly<Record<string, unknown>>) => void;
}

const DEGRADATION_NOTICE = "OpenTUI prompts degraded to line input for this process.";
const UNAVAILABLE_ERROR_NAME = "OpenTuiPromptUnavailableError";
let openTuiPromptDriverAvailable = true;

const isCi = (env: NodeJS.ProcessEnv): boolean => {
  const value = env.CI;
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
};

const isCancellation = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "PromptCancelledError";

const isUnavailable = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === UNAVAILABLE_ERROR_NAME;

const unavailableError = (): Error => {
  const error = new Error(DEGRADATION_NOTICE);
  error.name = UNAVAILABLE_ERROR_NAME;
  return error;
};

const degradeOpenTuiPrompts = (gate: InteractiveDriverGate, cause: unknown): void => {
  if (!openTuiPromptDriverAvailable) return;
  openTuiPromptDriverAvailable = false;
  gate.debug?.(DEGRADATION_NOTICE, { cause });
};

const adaptDriver = (raw: RawPromptDriver, gate: InteractiveDriverGate): PromptDriver => ({
  readRaw: async (request) => {
    if (!openTuiPromptDriverAvailable) throw unavailableError();
    try {
      return await raw.readRaw(request);
    } catch (cause) {
      if (isCancellation(cause)) {
        throw new PromptCancelledError(cause instanceof Error ? cause.message : undefined);
      }
      if (isUnavailable(cause)) degradeOpenTuiPrompts(gate, cause);
      throw cause;
    }
  },
});

export const resolveInteractivePromptDriver = async (
  gate: InteractiveDriverGate,
): Promise<PromptDriver | undefined> => {
  const env = gate.env ?? process.env;
  if (!gate.isTTY) return undefined;
  if (gate.yes === true) return undefined;
  if (gate.nonInteractive === true) return undefined;
  if (isCi(env)) return undefined;
  if (env.LANDO_NO_OPENTUI_PROMPTS === "1") return undefined;
  if (!openTuiPromptDriverAvailable) return undefined;

  try {
    const importPlugin =
      gate.importRendererPlugin ?? (() => import("@lando/renderer-lando") as Promise<RendererPluginModule>);
    const mod = await importPlugin();
    const loader = mod.loadInteractivePromptDriver;
    if (typeof loader !== "function") {
      degradeOpenTuiPrompts(gate, new Error("Renderer plugin has no interactive prompt driver loader."));
      return undefined;
    }
    return adaptDriver(await loader(), gate);
  } catch (cause) {
    degradeOpenTuiPrompts(
      gate,
      cause instanceof Error
        ? cause
        : new Error("Renderer plugin loading failed with a non-Error cause.", { cause }),
    );
    return undefined;
  }
};

export const resetInteractivePromptDegradationForTest = (): void => {
  openTuiPromptDriverAvailable = true;
};
