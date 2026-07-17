import type { NativeStyledTextModuleLike } from "./ansi-styled-text.ts";
import type { LiveRegionSpoolFactory } from "./live-region-spool.ts";

export type LiveRegionScreenMode = "alternate-screen" | "main-screen" | "split-footer";
type LiveRegionExternalOutputMode = "capture-stdout" | "passthrough";

export interface LiveRegionRenderableLike {
  add?(child: LiveRegionRenderableLike): unknown;
  destroy?(): unknown;
}

interface ScrollbackRenderContextLike {
  readonly width: number;
  readonly renderContext: unknown;
}

interface ScrollbackSnapshotLike {
  readonly root: LiveRegionRenderableLike;
  readonly width?: number;
  readonly height?: number;
  readonly startOnNewLine?: boolean;
  readonly trailingNewline?: boolean;
}

type ScrollbackWriterLike = (context: ScrollbackRenderContextLike) => ScrollbackSnapshotLike;

export interface LiveRegionRendererLike {
  readonly root: {
    add(child: LiveRegionRenderableLike): unknown;
  };
  writeToScrollback(writer: ScrollbackWriterLike): void;
  requestLive(): void;
  dropLive(): void;
  readonly liveRequestCount: number;
  targetFps: number;
  maxFps: number;
  resize(width: number, height: number): void;
  screenMode: LiveRegionScreenMode;
  externalOutputMode: LiveRegionExternalOutputMode;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  setCursorPosition(x: number, y: number, visible: boolean): void;
  on(event: "resize", listener: () => void): LiveRegionRendererLike;
  off(event: "resize", listener: () => void): LiveRegionRendererLike;
  footerHeight: number;
  resetSplitFooterForReplay(options: { readonly clearSavedLines: boolean }): void;
  destroy(): void;
}

interface RenderableConstructorLike {
  new (context: unknown, options: Record<string, unknown>): LiveRegionRenderableLike;
}

export interface OpenTuiLiveRegionModuleLike<
  TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike,
> extends NativeStyledTextModuleLike {
  createCliRenderer(config: Record<string, unknown>): Promise<TRenderer>;
  BoxRenderable: RenderableConstructorLike;
  TextRenderable: RenderableConstructorLike;
}

export interface LiveRegionControllerOptions {
  readonly stdout: NodeJS.WriteStream;
  readonly width: number;
  readonly height: number;
  readonly footerHeight: number;
  readonly onResize?: (width: number, height: number) => void;
}

export interface LiveRegionControllerDeps<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  readonly loadModule?: () => Promise<OpenTuiLiveRegionModuleLike<TRenderer>>;
  readonly createRenderer?: (module: OpenTuiLiveRegionModuleLike<TRenderer>) => Promise<TRenderer>;
  readonly spool?: LiveRegionSpoolFactory;
}
