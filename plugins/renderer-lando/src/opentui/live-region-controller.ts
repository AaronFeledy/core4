import { createInlineLiveRegionPainter } from "./inline-live-region.ts";
import {
  type FullTailSession,
  acquireFullTail,
  dropFullTailLive,
  leaveFullTail,
  paintFullTailFooter,
  requestFullTailLive,
} from "./live-region-full-tail.ts";
import {
  DeferredScrollback,
  type LiveRegionSpoolFactory,
  createLiveRegionSpool,
} from "./live-region-spool.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRendererLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
export type { OpenTuiLiveRegionFailureStage } from "./live-region-error.ts";
export type * from "./live-region-types.ts";

export class LiveRegionController<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  private footerLines: ReadonlyArray<string> = [];
  private readonly deferred: DeferredScrollback;
  private readonly inline: ReturnType<typeof createInlineLiveRegionPainter>;
  private readonly onStdoutResize: () => void;
  private width: number;
  private height: number;
  private disposed = false;
  private enteringFullTail = false;
  private fullTail: FullTailSession<TRenderer> | undefined;

  constructor(
    private readonly options: LiveRegionControllerOptions,
    private readonly deps: LiveRegionControllerDeps<TRenderer> = {},
    spoolFactory: LiveRegionSpoolFactory = createLiveRegionSpool,
  ) {
    this.width = options.width;
    this.height = options.height;
    this.deferred = new DeferredScrollback(deps.spool ?? spoolFactory);
    this.inline = createInlineLiveRegionPainter((text) => {
      options.stdout.write(text);
    });
    this.onStdoutResize = (): void => {
      const columns = options.stdout.columns;
      const rows = options.stdout.rows;
      if (typeof columns === "number" && typeof rows === "number") this.applyResize(columns, rows);
    };
    options.stdout.on("resize", this.onStdoutResize);
  }

  commitScrollback(text: string): void {
    if (this.fullTail !== undefined || this.enteringFullTail) {
      for (const source of rowsFor(text)) this.deferred.push(source);
      return;
    }
    this.inline.commitAbove(text);
    if (this.footerLines.length > 0) this.inline.paint(this.footerLines);
  }

  rememberScrollback(_text: string): void {}

  setFooter(lines: ReadonlyArray<string>): void {
    this.footerLines = [...lines];
    const session = this.fullTail;
    if (session !== undefined) {
      paintFullTailFooter(session, lines, this.width, this.height);
      return;
    }
    if (this.enteringFullTail) return;
    if (lines.length === 0) {
      this.inline.release();
      return;
    }
    this.inline.paint(lines);
  }

  requestLive(): void {
    const renderer = this.fullTail?.renderer;
    if (renderer !== undefined) requestFullTailLive(renderer);
  }

  dropLive(): void {
    const renderer = this.fullTail?.renderer;
    if (renderer !== undefined) dropFullTailLive(renderer);
  }

  resize(width: number, height: number): void {
    this.fullTail?.renderer.resize(width, height);
    this.applyResize(width, height);
  }

  private applyResize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.options.onResize?.(width, height);
  }

  async enterFullTail(): Promise<void> {
    if (this.fullTail !== undefined || this.enteringFullTail) return;
    this.enteringFullTail = true;
    try {
      this.fullTail = await acquireFullTail(this.options, this.deps, (width, height) => {
        this.applyResize(width, height);
      });
      if (this.footerLines.length > 0) {
        paintFullTailFooter(this.fullTail, this.footerLines, this.width, this.height);
      }
    } catch (cause) {
      const drained = await this.deferred.drain();
      for (const source of drained) this.inline.commitAbove(source);
      if (this.footerLines.length > 0) this.inline.paint(this.footerLines);
      throw cause;
    } finally {
      this.enteringFullTail = false;
    }
  }

  async exitFullTail(): Promise<void> {
    const session = this.fullTail;
    if (session === undefined) return;
    const drained = await this.deferred.drain();
    leaveFullTail(session);
    this.fullTail = undefined;
    for (const source of drained) this.inline.commitAbove(source);
    if (this.footerLines.length > 0) this.inline.paint(this.footerLines);
  }

  async reset(): Promise<void> {
    await this.deferred.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.options.stdout.off("resize", this.onStdoutResize);
    this.inline.release();
    try {
      const session = this.fullTail;
      if (session !== undefined) {
        leaveFullTail(session);
        this.fullTail = undefined;
      }
    } catch (cause) {
      recordOpenTuiSubstrateFailure(cause);
      throw cause;
    } finally {
      await this.deferred.clear();
    }
  }
}

const rowsFor = (text: string): ReadonlyArray<string> =>
  (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

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
  return new LiveRegionController(options, deps, deps.spool ?? createLiveRegionSpool);
}
