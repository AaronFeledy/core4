import { ansiToNativeStyledText } from "./ansi-styled-text.ts";
import { acquireLiveRegionSubstrate } from "./live-region-substrate.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRenderableLike,
  LiveRegionRendererLike,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export type FullTailSession<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> = {
  readonly module: OpenTuiLiveRegionModuleLike<TRenderer>;
  readonly renderer: TRenderer;
  readonly resizeListener: () => void;
  footer: LiveRegionRenderableLike | undefined;
};

const capFps = (renderer: LiveRegionRendererLike): void => {
  renderer.targetFps = Math.min(renderer.targetFps, 30);
  renderer.maxFps = Math.min(renderer.maxFps, 30);
};

export const acquireFullTail = async <TRenderer extends LiveRegionRendererLike>(
  options: LiveRegionControllerOptions,
  deps: LiveRegionControllerDeps<TRenderer>,
  onTerminalResize: (width: number, height: number) => void,
): Promise<FullTailSession<TRenderer>> => {
  const { module, renderer } = await acquireLiveRegionSubstrate(options, deps);
  const resizeListener = (): void => {
    onTerminalResize(renderer.terminalWidth, renderer.terminalHeight);
  };
  try {
    capFps(renderer);
    renderer.on("resize", resizeListener);
    renderer.externalOutputMode = "passthrough";
    renderer.screenMode = "alternate-screen";
    return { footer: undefined, module, renderer, resizeListener };
  } catch (cause) {
    try {
      renderer.off("resize", resizeListener);
      renderer.destroy();
    } catch (cleanupCause) {
      recordOpenTuiSubstrateFailure(cleanupCause);
    }
    throw cause;
  }
};

export const paintFullTailFooter = <TRenderer extends LiveRegionRendererLike>(
  session: FullTailSession<TRenderer>,
  lines: ReadonlyArray<string>,
  width: number,
  height: number,
): void => {
  session.footer?.destroy?.();
  session.footer = undefined;
  if (lines.length === 0) return;
  const closingLine = lines.at(-1);
  const visibleLines =
    lines.length <= height || closingLine === undefined
      ? lines
      : [...lines.slice(0, Math.max(0, height - 1)), closingLine];
  const footer = new session.module.BoxRenderable(session.renderer, {
    flexDirection: "column",
    height: Math.max(1, visibleLines.length),
    id: "lando-live-region-footer",
    width,
  });
  for (const [index, line] of visibleLines.entries()) {
    footer.add?.(
      new session.module.TextRenderable(session.renderer, {
        content: ansiToNativeStyledText(session.module, line),
        height: 1,
        id: `lando-live-region-line-${index}`,
        width,
      }),
    );
  }
  session.renderer.root.add(footer);
  session.footer = footer;
};

export const requestFullTailLive = (renderer: LiveRegionRendererLike): void => {
  capFps(renderer);
  renderer.requestLive();
};

export const dropFullTailLive = (renderer: LiveRegionRendererLike): void => {
  capFps(renderer);
  renderer.dropLive();
};

export const leaveFullTail = (session: FullTailSession): void => {
  session.renderer.off("resize", session.resizeListener);
  session.renderer.externalOutputMode = "passthrough";
  session.footer?.destroy?.();
  session.footer = undefined;
  session.renderer.destroy();
};
