import { hasNativeStyledText } from "./ansi-styled-text.ts";
import { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRendererLike,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export interface LiveRegionSubstrate<TRenderer extends LiveRegionRendererLike> {
  readonly module: OpenTuiLiveRegionModuleLike<TRenderer>;
  readonly renderer: TRenderer;
}

type LiveRegionModuleLoader = () => Promise<OpenTuiLiveRegionModuleLike>;

let cachedModule: Promise<OpenTuiLiveRegionModuleLike> | undefined;

const isOpenTuiLiveRegionModule = (value: unknown): value is OpenTuiLiveRegionModuleLike =>
  value !== null &&
  typeof value === "object" &&
  "createCliRenderer" in value &&
  typeof value.createCliRenderer === "function" &&
  "BoxRenderable" in value &&
  typeof value.BoxRenderable === "function" &&
  "TextRenderable" in value &&
  typeof value.TextRenderable === "function" &&
  hasNativeStyledText(value);

const loadOpenTuiModule = async (): Promise<OpenTuiLiveRegionModuleLike> => {
  const module: unknown = await import("@opentui/core");
  if (!isOpenTuiLiveRegionModule(module)) {
    throw new TypeError("The loaded OpenTUI module does not provide the live-region renderer surface.");
  }
  return module;
};

const resolveLiveRegionModule = (
  loadModule?: LiveRegionModuleLoader,
): Promise<OpenTuiLiveRegionModuleLike> => {
  if (cachedModule !== undefined) return cachedModule;
  if (loadModule !== undefined) return loadModule();
  cachedModule = loadOpenTuiModule();
  return cachedModule;
};

export const prefetchLiveRegionModule = (loadModule: LiveRegionModuleLoader = loadOpenTuiModule): void => {
  cachedModule ??= loadModule();
  void cachedModule.catch(recordOpenTuiSubstrateFailure);
};

export const resetLiveRegionModuleCacheForTests = (): void => {
  cachedModule = undefined;
};

export function acquireLiveRegionSubstrate(
  options: LiveRegionControllerOptions,
): Promise<LiveRegionSubstrate<LiveRegionRendererLike>>;
export function acquireLiveRegionSubstrate<TRenderer extends LiveRegionRendererLike>(
  options: LiveRegionControllerOptions,
  deps: LiveRegionControllerDeps<TRenderer>,
): Promise<LiveRegionSubstrate<TRenderer>>;
export async function acquireLiveRegionSubstrate(
  options: LiveRegionControllerOptions,
  deps: LiveRegionControllerDeps = {},
): Promise<LiveRegionSubstrate<LiveRegionRendererLike>> {
  let module: OpenTuiLiveRegionModuleLike;
  try {
    module = await resolveLiveRegionModule(deps.loadModule);
  } catch (cause) {
    recordOpenTuiSubstrateFailure(cause);
    throw new OpenTuiLiveRegionUnavailableError("load", cause);
  }

  let renderer: LiveRegionRendererLike | undefined;
  try {
    renderer = await (deps.createRenderer?.(module) ??
      module.createCliRenderer({
        screenMode: "alternate-screen",
        clearOnShutdown: false,
        exitOnCtrlC: false,
        externalOutputMode: "passthrough",
        stdout: options.stdout,
        width: options.width,
        height: options.height,
      }));
    return { module, renderer };
  } catch (cause) {
    recordOpenTuiSubstrateFailure(cause);
    try {
      renderer?.destroy();
    } catch (cleanupCause) {
      recordOpenTuiSubstrateFailure(
        cleanupCause instanceof Error
          ? cleanupCause
          : new Error("OpenTUI live-region cleanup failed with a non-Error cause.", {
              cause: cleanupCause,
            }),
      );
    }
    throw new OpenTuiLiveRegionUnavailableError("initialize", cause);
  }
}
