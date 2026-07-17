import { ansiToNativeStyledText } from "./ansi-styled-text.ts";
import { LiveRegionReplay, type ReplayLine, replaySnapshot } from "./live-region-replay.ts";
import { acquireLiveRegionSubstrate } from "./live-region-substrate.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRenderableLike,
  LiveRegionRendererLike,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
export type { OpenTuiLiveRegionFailureStage } from "./live-region-error.ts";
export type * from "./live-region-types.ts";

export class LiveRegionController<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  private footer: LiveRegionRenderableLike | undefined;
  private footerLines: ReadonlyArray<string> = [];
  private readonly replay: LiveRegionReplay;
  private readonly deferredLines: ReplayLine[] = [];
  private width: number;
  private height: number;
  private replayPending = false;
  private disposed = false;
  private readonly resizeListener: () => void;

  constructor(
    private readonly module: OpenTuiLiveRegionModuleLike<TRenderer>,
    private readonly renderer: TRenderer,
    width: number,
    height: number,
    private readonly onResize: ((width: number, height: number) => void) | undefined,
    private readonly writePassthrough: (text: string) => void,
  ) {
    this.width = width;
    this.height = height;
    this.replay = new LiveRegionReplay(module, width, Math.max(0, height - renderer.footerHeight));
    this.renderer.targetFps = Math.min(this.renderer.targetFps, 30);
    this.renderer.maxFps = Math.min(this.renderer.maxFps, 30);
    this.resizeListener = () => {
      const nextWidth = this.renderer.terminalWidth;
      const nextHeight = this.renderer.terminalHeight;
      this.applyResize(nextWidth, nextHeight);
    };
    this.renderer.on("resize", this.resizeListener);
  }

  commitScrollback(text: string): void {
    for (const line of this.linesFor(text)) {
      if (this.renderer.screenMode === "alternate-screen") {
        this.deferredLines.push(line);
        continue;
      }
      this.replay.push(line);
      if (this.renderer.screenMode === "split-footer") this.writeScrollback(line);
      else this.writePassthrough(`${line.chunks.map((chunk) => chunk.text).join("")}\n`);
    }
  }

  rememberScrollback(text: string): void {
    for (const line of this.linesFor(text)) this.replay.push(line);
  }

  private linesFor(text: string): ReadonlyArray<ReplayLine> {
    const rows = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    return rows.map((row) => this.replay.line(row));
  }

  private writeScrollback(line: ReplayLine): void {
    this.renderer.writeToScrollback((context) => replaySnapshot(this.module, context, line));
  }

  setFooter(lines: ReadonlyArray<string>): void {
    this.footerLines = [...lines];
    if (lines.length === 0 && this.renderer.screenMode !== "alternate-screen") {
      this.footer?.destroy?.();
      this.footer = undefined;
      if (this.renderer.screenMode === "split-footer") {
        this.renderer.externalOutputMode = "passthrough";
        this.renderer.screenMode = "main-screen";
      }
      return;
    }
    const reactivating = this.renderer.screenMode === "main-screen";
    if (reactivating) {
      this.renderer.externalOutputMode = "passthrough";
      this.renderer.screenMode = "split-footer";
    }
    this.renderFooter(reactivating);
  }

  requestLive(): void {
    this.renderer.targetFps = Math.min(this.renderer.targetFps, 30);
    this.renderer.maxFps = Math.min(this.renderer.maxFps, 30);
    this.renderer.requestLive();
  }

  dropLive(): void {
    this.renderer.targetFps = Math.min(this.renderer.targetFps, 30);
    this.renderer.maxFps = Math.min(this.renderer.maxFps, 30);
    this.renderer.dropLive();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
    this.applyResize(width, height);
  }

  private applyResize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.onResize?.(width, height);
    const footerHeight = this.renderer.screenMode === "main-screen" ? 0 : this.renderer.footerHeight;
    this.replay.resize(width, Math.max(0, height - footerHeight));
    this.replayAfterResize();
  }

  enterFullTail(): void {
    if (this.renderer.screenMode === "alternate-screen") return;
    this.renderer.externalOutputMode = "passthrough";
    this.renderer.screenMode = "alternate-screen";
  }

  exitFullTail(): void {
    if (this.renderer.screenMode !== "alternate-screen") return;
    this.renderer.screenMode = "split-footer";
    this.renderer.setCursorPosition(1, Math.max(1, this.height), false);
    this.renderer.externalOutputMode = "capture-stdout";
    const replayAfterResize = this.replayPending;
    if (replayAfterResize) {
      this.resetReplaySurface();
    }
    for (const line of this.deferredLines) {
      this.writeScrollback(line);
      this.replay.push(line);
    }
    this.deferredLines.length = 0;
    if (replayAfterResize) this.pinSplitFooter();
    if (this.footer !== undefined) this.renderFooter();
    this.replayPending = false;
  }

  reset(): void {
    this.resetReplaySurface();
    this.pinSplitFooter();
    if (this.footer !== undefined) this.renderFooter();
  }

  private resetReplaySurface(): void {
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: true });
    for (const line of this.replay.retainedLines()) this.writeScrollback(line);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.renderer.off("resize", this.resizeListener);
      this.renderer.destroy();
    } catch (cause) {
      recordOpenTuiSubstrateFailure(cause);
      throw cause;
    }
  }

  private replayAfterResize(): void {
    if (this.renderer.screenMode === "split-footer") {
      this.reset();
      return;
    }
    this.replayPending = true;
  }

  private pinSplitFooter(footerHeight?: number): void {
    if (this.renderer.screenMode !== "split-footer") {
      if (footerHeight !== undefined) this.renderer.footerHeight = footerHeight;
      return;
    }
    this.renderer.externalOutputMode = "passthrough";
    if (footerHeight !== undefined) this.renderer.footerHeight = footerHeight;
    this.renderer.setCursorPosition(1, Math.max(1, this.height), false);
    this.renderer.externalOutputMode = "capture-stdout";
  }

  private renderFooter(forcePin = false): void {
    this.footer?.destroy?.();
    const closingLine = this.footerLines.at(-1);
    const visibleLines =
      this.footerLines.length <= this.height || closingLine === undefined
        ? this.footerLines
        : [...this.footerLines.slice(0, Math.max(0, this.height - 1)), closingLine];
    const footerHeight = Math.max(1, visibleLines.length);
    const footer = new this.module.BoxRenderable(this.renderer, {
      height: footerHeight,
      id: "lando-live-region-footer",
      flexDirection: "column",
      width: this.width,
    });
    for (const [index, line] of visibleLines.entries()) {
      footer.add?.(
        new this.module.TextRenderable(this.renderer, {
          content: ansiToNativeStyledText(this.module, line),
          height: 1,
          id: `lando-live-region-line-${index}`,
          width: this.width,
        }),
      );
    }
    if (forcePin || this.renderer.footerHeight !== footerHeight) {
      this.pinSplitFooter(footerHeight);
      this.replay.resize(this.width, Math.max(0, this.height - footerHeight));
    }
    this.renderer.root.add(footer);
    this.footer = footer;
  }
}

export async function createLiveRegionController(
  options: LiveRegionControllerOptions,
): Promise<LiveRegionController>;
export async function createLiveRegionController<TRenderer extends LiveRegionRendererLike>(
  options: LiveRegionControllerOptions,
  deps: LiveRegionControllerDeps<TRenderer>,
): Promise<LiveRegionController<TRenderer>>;
export async function createLiveRegionController(
  options: LiveRegionControllerOptions,
  deps: LiveRegionControllerDeps = {},
): Promise<LiveRegionController> {
  const { module, renderer } = await acquireLiveRegionSubstrate(options, deps);
  return new LiveRegionController(module, renderer, options.width, options.height, options.onResize, (text) =>
    options.stdout.write(text),
  );
}
