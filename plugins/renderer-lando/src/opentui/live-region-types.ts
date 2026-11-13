import type { NativeStyledTextModuleLike } from "./ansi-styled-text.ts";
import type { LiveRegionSpoolFactory } from "./live-region-spool.ts";
import type { OpenTuiModuleLike, RendererLike } from "./prompt-driver-types.ts";

export type LiveRegionScreenMode = "alternate-screen" | "main-screen" | "split-footer";
type LiveRegionExternalOutputMode = "capture-stdout" | "passthrough";

export interface LiveRegionRenderableLike {
  add?(child: LiveRegionRenderableLike): unknown;
  destroy?(): unknown;
}

export interface LiveRegionRendererLike extends Pick<RendererLike, "addPostProcessFn"> {
  readonly root: {
    add(child: LiveRegionRenderableLike): unknown;
  };
  requestLive(): void;
  dropLive(): void;
  targetFps: number;
  maxFps: number;
  resize(width: number, height: number): void;
  screenMode: LiveRegionScreenMode;
  externalOutputMode: LiveRegionExternalOutputMode;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  on(event: "resize", listener: () => void): LiveRegionRendererLike;
  off(event: "resize", listener: () => void): LiveRegionRendererLike;
  /** Restores the terminal asynchronously; await `closed` before writing to the terminal again. */
  destroy(): void;
  /** Settles after destruction writes the remaining output and restores the terminal. */
  readonly closed: Promise<void>;
  /** Hands the terminal back; OpenTUI rejects a transition while another one is pending. */
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

interface RenderableConstructorLike {
  new (context: unknown, options: Record<string, unknown>): LiveRegionRenderableLike;
}

export interface OpenTuiLiveRegionModuleLike<
  TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike,
> extends NativeStyledTextModuleLike {
  createCliRenderer(config: Record<string, unknown>): Promise<TRenderer>;
  readonly RGBA: NativeStyledTextModuleLike["RGBA"] & OpenTuiModuleLike["RGBA"];
  BoxRenderable: RenderableConstructorLike;
  TextRenderable: new (
    context: unknown,
    options: Record<string, unknown>,
  ) => Pick<LiveRegionRenderableLike, "destroy">;
}

export interface LiveRegionStdout {
  write(chunk: string | Uint8Array): boolean;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
  emit?(event: "resize"): boolean;
  columns?: number;
  rows?: number;
}

export interface LiveRegionControllerOptions {
  readonly stdout: LiveRegionStdout;
  readonly noColor?: boolean;
  readonly width: number;
  readonly height: number;
  readonly onResize?: (width: number, height: number) => void;
}

export interface LiveRegionControllerDeps<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  readonly loadModule?: () => Promise<OpenTuiLiveRegionModuleLike<TRenderer>>;
  readonly createRenderer?: (module: OpenTuiLiveRegionModuleLike<TRenderer>) => Promise<TRenderer>;
  readonly spool?: LiveRegionSpoolFactory;
}
