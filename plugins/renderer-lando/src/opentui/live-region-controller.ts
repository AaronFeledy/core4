export type LiveRegionScreenMode = "alternate-screen" | "main-screen" | "split-footer";

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
  footerHeight: number;
  resetSplitFooterForReplay(options: { readonly clearSavedLines: boolean }): void;
  destroy(): void;
}

interface RenderableConstructorLike {
  new (context: unknown, options: Record<string, unknown>): LiveRegionRenderableLike;
}

export interface OpenTuiLiveRegionModuleLike<
  TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike,
> {
  createCliRenderer(config: Record<string, unknown>): Promise<TRenderer>;
  BoxRenderable: RenderableConstructorLike;
  TextRenderable: RenderableConstructorLike;
}

export interface LiveRegionControllerOptions {
  readonly stdout: NodeJS.WriteStream;
  readonly width: number;
  readonly height: number;
  readonly footerHeight: number;
}

export interface LiveRegionControllerDeps<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  readonly loadModule?: () => Promise<OpenTuiLiveRegionModuleLike<TRenderer>>;
  readonly createRenderer?: (module: OpenTuiLiveRegionModuleLike<TRenderer>) => Promise<TRenderer>;
}

export type OpenTuiLiveRegionFailureStage = "load" | "initialize";

export class OpenTuiLiveRegionUnavailableError extends Error {
  override readonly name = "OpenTuiLiveRegionUnavailableError";

  constructor(
    readonly stage: OpenTuiLiveRegionFailureStage,
    cause: unknown,
  ) {
    super(`OpenTUI live region failed to ${stage === "load" ? "load" : "initialize"}.`, { cause });
  }
}

const isOpenTuiLiveRegionModule = (value: unknown): value is OpenTuiLiveRegionModuleLike =>
  value !== null &&
  typeof value === "object" &&
  "createCliRenderer" in value &&
  typeof value.createCliRenderer === "function" &&
  "BoxRenderable" in value &&
  typeof value.BoxRenderable === "function" &&
  "TextRenderable" in value &&
  typeof value.TextRenderable === "function";

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
  private width: number;
  private disposed = false;

  constructor(
    private readonly module: OpenTuiLiveRegionModuleLike<TRenderer>,
    private readonly renderer: TRenderer,
    width: number,
  ) {
    this.width = width;
    this.renderer.targetFps = Math.min(this.renderer.targetFps, 30);
    this.renderer.maxFps = Math.min(this.renderer.maxFps, 30);
  }

  commitScrollback(text: string): void {
    this.renderer.writeToScrollback((context) => ({
      root: new this.module.TextRenderable(context.renderContext, {
        content: text,
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
    this.width = width;
    this.renderer.resize(width, height);
    if (this.footer !== undefined) this.renderFooter();
  }

  enterFullTail(): void {
    this.renderer.screenMode = "alternate-screen";
  }

  exitFullTail(): void {
    this.renderer.screenMode = "split-footer";
  }

  reset(): void {
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.destroy();
  }

  private renderFooter(): void {
    this.footer?.destroy?.();
    const footerHeight = Math.max(1, this.footerLines.length);
    const footer = new this.module.BoxRenderable(this.renderer, {
      height: footerHeight,
      id: "lando-live-region-footer",
      flexDirection: "column",
      width: this.width,
    });
    for (const [index, line] of this.footerLines.entries()) {
      footer.add?.(
        new this.module.TextRenderable(this.renderer, {
          content: line,
          height: 1,
          id: `lando-live-region-line-${index}`,
          width: this.width,
        }),
      );
    }
    this.renderer.footerHeight = footerHeight;
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

  let renderer: LiveRegionRendererLike;
  try {
    renderer = await (deps.createRenderer?.(module) ??
      module.createCliRenderer({
        screenMode: "split-footer",
        externalOutputMode: "capture-stdout",
        stdout: options.stdout,
        width: options.width,
        height: options.height,
        footerHeight: options.footerHeight,
      }));
  } catch (cause) {
    throw new OpenTuiLiveRegionUnavailableError("initialize", cause);
  }

  return new LiveRegionController(module, renderer, options.width);
}
