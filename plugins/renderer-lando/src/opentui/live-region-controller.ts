import { ansiToNativeStyledText, hasNativeStyledText } from "./ansi-styled-text.ts";
import { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRenderableLike,
  LiveRegionRendererLike,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";

export { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
export type { OpenTuiLiveRegionFailureStage } from "./live-region-error.ts";
export type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRenderableLike,
  LiveRegionRendererLike,
  LiveRegionScreenMode,
  OpenTuiLiveRegionModuleLike,
} from "./live-region-types.ts";

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

export class LiveRegionController<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  private footer: LiveRegionRenderableLike | undefined;
  private footerLines: ReadonlyArray<string> = [];
  private readonly scrollbackLines: string[] = [];
  private width: number;
  private height: number;
  private deferredCommitIndex: number | undefined;
  private replayPending = false;
  private disposed = false;
  private readonly resizeListener: () => void;

  constructor(
    private readonly module: OpenTuiLiveRegionModuleLike<TRenderer>,
    private readonly renderer: TRenderer,
    width: number,
    height: number,
    private readonly onResize: ((width: number, height: number) => void) | undefined,
  ) {
    this.width = width;
    this.height = height;
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
    this.scrollbackLines.push(text);
    if (this.renderer.screenMode !== "split-footer") return;
    this.writeScrollback(text);
  }

  private writeScrollback(text: string): void {
    this.renderer.writeToScrollback((context) => ({
      root: new this.module.TextRenderable(context.renderContext, {
        content: ansiToNativeStyledText(this.module, text),
        width: context.width,
      }),
      width: context.width,
      startOnNewLine: true,
      trailingNewline: true,
    }));
  }

  setFooter(lines: ReadonlyArray<string>): void {
    this.footerLines = [...lines];
    this.renderFooter();
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
    this.replayAfterResize();
  }

  enterFullTail(): void {
    if (this.renderer.screenMode === "alternate-screen") return;
    this.deferredCommitIndex = this.scrollbackLines.length;
    this.renderer.externalOutputMode = "passthrough";
    this.renderer.screenMode = "alternate-screen";
  }

  exitFullTail(): void {
    if (this.renderer.screenMode !== "alternate-screen") return;
    this.renderer.screenMode = "split-footer";
    this.renderer.setCursorPosition(1, Math.max(1, this.height), false);
    this.renderer.externalOutputMode = "capture-stdout";
    if (this.replayPending) {
      this.reset();
    } else {
      for (const line of this.scrollbackLines.slice(this.deferredCommitIndex)) this.writeScrollback(line);
      if (this.footer !== undefined) this.renderFooter();
    }
    this.deferredCommitIndex = undefined;
    this.replayPending = false;
  }

  reset(): void {
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: false });
    for (const line of this.scrollbackLines) this.writeScrollback(line);
    this.pinSplitFooter();
    if (this.footer !== undefined) this.renderFooter();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.off("resize", this.resizeListener);
    this.renderer.destroy();
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

  private renderFooter(): void {
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
    if (this.renderer.footerHeight !== footerHeight) this.pinSplitFooter(footerHeight);
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
  let module: OpenTuiLiveRegionModuleLike;
  try {
    module = await (deps.loadModule?.() ?? loadOpenTuiModule());
  } catch (cause) {
    throw new OpenTuiLiveRegionUnavailableError("load", cause);
  }

  let renderer: LiveRegionRendererLike | undefined;
  try {
    renderer = await (deps.createRenderer?.(module) ??
      module.createCliRenderer({
        screenMode: "split-footer",
        externalOutputMode: "passthrough",
        exitOnCtrlC: false,
        stdout: options.stdout,
        width: options.width,
        height: options.height,
        footerHeight: options.footerHeight,
      }));

    renderer.externalOutputMode = "passthrough";
    renderer.screenMode = "split-footer";
    renderer.footerHeight = options.footerHeight;
    renderer.setCursorPosition(1, Math.max(1, options.height), false);
    renderer.externalOutputMode = "capture-stdout";

    return new LiveRegionController(module, renderer, options.width, options.height, options.onResize);
  } catch (cause) {
    renderer?.destroy();
    throw new OpenTuiLiveRegionUnavailableError("initialize", cause);
  }
}
