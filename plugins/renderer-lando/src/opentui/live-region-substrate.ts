import { hasNativeStyledText } from "./ansi-styled-text.ts";
import { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRendererLike,
  LiveRegionStdin,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";
import { installMonochromePromptAdapters, monochromePromptTerminal } from "./prompt-monochrome.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export interface LiveRegionSubstrate<TRenderer extends LiveRegionRendererLike> {
  readonly module: OpenTuiLiveRegionModuleLike<TRenderer>;
  readonly renderer: TRenderer;
  /** Destroys the renderer and hands stdin back; resolves once OpenTUI has restored the terminal. */
  readonly close: () => Promise<void>;
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

/** Destroys the renderer and waits until OpenTUI restores the terminal and flushes its output. */
const closeRenderer = async (renderer: Pick<LiveRegionRendererLike, "destroy" | "closed">): Promise<void> => {
  renderer.destroy();
  await renderer.closed;
};

interface StdinMode {
  readonly raw: boolean;
  readonly flowing: boolean;
}

const stdinMode = (stdin: LiveRegionStdin): StdinMode => ({
  raw: stdin.isRaw === true,
  flowing: stdin.readableFlowing === true,
});

/**
 * OpenTUI's teardown leaves raw mode and pauses stdin, which silences a key listener that stays attached
 * across full-tail. Closing gives stdin back the mode it had when OpenTUI took it, unless another owner
 * changed that mode while OpenTUI held it, as releasing the key listener does at shutdown.
 */
const closeHandingBackStdin = async (
  renderer: Pick<LiveRegionRendererLike, "destroy" | "closed">,
  stdin: LiveRegionStdin,
  held: StdinMode,
): Promise<void> => {
  const current = stdinMode(stdin);
  const untouched = current.raw === held.raw && current.flowing === held.flowing;
  try {
    await closeRenderer(renderer);
  } finally {
    if (untouched && stdin.isTTY === true && stdin.isRaw !== held.raw) stdin.setRawMode?.(held.raw);
    if (untouched && held.flowing && stdin.readableFlowing !== true) stdin.resume();
  }
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

  const stdin = deps.stdin ?? process.stdin;
  const held = stdinMode(stdin);
  let renderer: LiveRegionRendererLike | undefined;
  try {
    renderer = await (deps.createRenderer?.(module) ??
      module.createCliRenderer({
        stdin,
        screenMode: "alternate-screen",
        clearOnShutdown: false,
        exitOnCtrlC: false,
        // Lando owns signals and tears the renderer down through the controller; OpenTUI's own
        // SIGINT handler would destroy it underneath a live paint.
        exitSignals: [],
        externalOutputMode: "passthrough",
        useMouse: false,
        stdout: options.noColor === true ? monochromePromptTerminal(options.stdout) : options.stdout,
        ...(options.noColor === true ? { backgroundColor: module.RGBA.defaultBackground() } : {}),
        remote: false,
        width: options.width,
        height: options.height,
      }));
    if (options.noColor === true) installMonochromePromptAdapters(module, renderer);
    const created = renderer;
    return {
      module,
      renderer: created,
      close: () => closeHandingBackStdin(created, stdin, held),
    };
  } catch (cause) {
    recordOpenTuiSubstrateFailure(cause);
    try {
      if (renderer !== undefined) await closeHandingBackStdin(renderer, stdin, held);
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
