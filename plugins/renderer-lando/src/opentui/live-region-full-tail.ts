import { ansiToNativeStyledText } from "./ansi-styled-text.ts";
import { acquireLiveRegionSubstrate, closeRenderer } from "./live-region-substrate.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRenderableLike,
  LiveRegionRendererLike,
  LiveRegionTextLike,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

type FullTailFooter = {
  readonly box: LiveRegionRenderableLike;
  readonly rows: Array<{ line: string; readonly text: LiveRegionTextLike }>;
};

export type FullTailSession<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> = {
  readonly module: OpenTuiLiveRegionModuleLike<TRenderer>;
  readonly renderer: TRenderer;
  readonly resizeListener: () => void;
  readonly noColor: boolean;
  footer: FullTailFooter | undefined;
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
    return { footer: undefined, module, renderer, resizeListener, noColor: options.noColor === true };
  } catch (cause) {
    try {
      renderer.off("resize", resizeListener);
      await closeRenderer(renderer);
    } catch (cleanupCause) {
      recordOpenTuiSubstrateFailure(cleanupCause);
    }
    throw cause;
  }
};

const removeFullTailFooter = (session: FullTailSession): void => {
  // Destroying a box detaches its rows without destroying them, so each row is destroyed too.
  session.footer?.box.destroy?.();
  for (const row of session.footer?.rows ?? []) row.text.destroy?.();
  session.footer = undefined;
};

/**
 * Keeps the footer mounted and rewrites only the rows whose text changed, so OpenTUI repaints those rows
 * instead of laying out a new tree for every spinner frame.
 */
export const paintFullTailFooter = <TRenderer extends LiveRegionRendererLike>(
  session: FullTailSession<TRenderer>,
  lines: ReadonlyArray<string>,
  width: number,
  height: number,
): void => {
  const closingLine = lines.at(-1);
  const visibleLines =
    lines.length <= height || closingLine === undefined
      ? lines
      : [...lines.slice(0, Math.max(0, height - 1)), closingLine];
  if (visibleLines.length === 0) {
    removeFullTailFooter(session);
    return;
  }
  const { module, renderer } = session;
  const mounted = session.footer;
  const footer = mounted ?? {
    box: new module.BoxRenderable(renderer, {
      flexDirection: "column",
      height: visibleLines.length,
      id: "lando-live-region-footer",
      width,
      ...(session.noColor ? { backgroundColor: module.RGBA.defaultBackground() } : {}),
    }),
    rows: [],
  };
  footer.box.width = width;
  footer.box.height = visibleLines.length;
  for (const [index, line] of visibleLines.entries()) {
    const row = footer.rows[index];
    if (row === undefined) {
      const text = new module.TextRenderable(renderer, {
        content: ansiToNativeStyledText(module, line),
        height: 1,
        id: `lando-live-region-line-${index}`,
        width,
        ...(session.noColor
          ? { fg: module.RGBA.defaultForeground(), bg: module.RGBA.defaultBackground() }
          : {}),
      });
      footer.box.add?.(text);
      footer.rows.push({ line, text });
      continue;
    }
    row.text.width = width;
    if (row.line === line) continue;
    row.text.content = ansiToNativeStyledText(module, line);
    row.line = line;
  }
  for (const row of footer.rows.splice(visibleLines.length)) row.text.destroy?.();
  if (mounted === undefined) {
    // Mount once with every row in place, so the first frame never shows a partial footer.
    renderer.root.add(footer.box);
    session.footer = footer;
  }
};

export const requestFullTailRegion = (renderer: LiveRegionRendererLike): void => {
  capFps(renderer);
  renderer.requestLive();
};

export const dropFullTailRegion = (renderer: LiveRegionRendererLike): void => {
  capFps(renderer);
  renderer.dropLive();
};

/** Resolves once OpenTUI has restored the terminal, so later writes reach the main screen. */
export const leaveFullTail = async (session: FullTailSession): Promise<void> => {
  session.renderer.off("resize", session.resizeListener);
  session.renderer.externalOutputMode = "passthrough";
  removeFullTailFooter(session);
  await closeRenderer(session.renderer);
};
