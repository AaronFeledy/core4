import { isInPlaceTerminalUpdate } from "./ansi-styled-text.ts";
import { createInlineLiveRegionPainter } from "./inline-live-region.ts";
import {
  type FullTailSession,
  acquireFullTail,
  dropFullTailRegion,
  leaveFullTail,
  paintFullTailFooter,
  requestFullTailRegion,
} from "./live-region-full-tail.ts";
import {
  DeferredScrollback,
  type LiveRegionSpoolFactory,
  createLiveRegionSpool,
} from "./live-region-spool.ts";
import { TransitionQueue } from "./live-region-transitions.ts";
import type {
  LiveRegionControllerDeps,
  LiveRegionControllerOptions,
  LiveRegionRendererLike,
} from "./live-region-types.ts";
import { recordOpenTuiSubstrateFailure } from "./substrate-availability.ts";

export type { OpenTuiLiveRegionFailureStage } from "./live-region-error.ts";
export { OpenTuiLiveRegionUnavailableError } from "./live-region-error.ts";
export type * from "./live-region-types.ts";

export class LiveRegionController<TRenderer extends LiveRegionRendererLike = LiveRegionRendererLike> {
  private footerLines: ReadonlyArray<string> = [];
  private openLine = false;
  private fullTailSuspended = false;
  private readonly deferred: DeferredScrollback;
  private readonly inline: ReturnType<typeof createInlineLiveRegionPainter>;
  private readonly onStdoutResize: () => void;
  private width: number;
  private height: number;
  private disposed = false;
  private enteringFullTail = false;
  private leavingFullTail = false;
  private fullTail: FullTailSession<TRenderer> | undefined;
  private readonly transitions = new TransitionQueue();

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
      if (typeof columns === "number" && typeof rows === "number") this.resize(columns, rows);
    };
    options.stdout.on("resize", this.onStdoutResize);
  }

  commitScrollback(text: string): void {
    if (this.fullTail !== undefined || this.enteringFullTail || this.leavingFullTail) {
      for (const source of rowsFor(text)) this.deferred.push(source);
      return;
    }
    this.inline.commitAbove(text);
    this.openLine = isInPlaceTerminalUpdate(text);
    if (this.footerLines.length > 0 && !this.openLine) this.inline.paint(this.footerLines);
  }

  rememberScrollback(_text: string): void {}

  /** Resolves after the payload is written; inline-only output completes synchronously. */
  suspendOutput(chunk: string | Uint8Array, write: () => void): void | Promise<void> {
    if (this.fullTail === undefined && this.transitions.idle) {
      this.writeInlinePayload(chunk, write);
      return;
    }
    return this.transitions.run(() => this.writeFullTailPayload(chunk, write));
  }

  private writeInlinePayload(chunk: string | Uint8Array, write: () => void): void {
    this.inline.paint([]);
    try {
      write();
    } finally {
      this.notePayload(chunk);
      if (!this.openLine && this.footerLines.length > 0) this.inline.paint(this.footerLines);
    }
  }

  private async writeFullTailPayload(chunk: string | Uint8Array, write: () => void): Promise<void> {
    const session = this.liveFullTail();
    if (session === undefined) {
      this.fullTailSuspended = false;
      this.writeInlinePayload(chunk, write);
      return;
    }
    if (!this.fullTailSuspended) {
      this.fullTailSuspended = true;
      // A failed hand-off leaves the renderer in charge, so footer updates must keep painting.
      await session.renderer.suspend().catch((cause: unknown) => {
        this.fullTailSuspended = false;
        throw cause;
      });
    }
    try {
      write();
    } finally {
      this.notePayload(chunk);
      if (!this.openLine) {
        await session.renderer.resume().finally(() => {
          this.fullTailSuspended = false;
        });
        paintFullTailFooter(session, this.footerLines, this.width, this.height);
      }
    }
  }

  /** A chunk that ends mid-line keeps the region suspended until a later chunk ends the line. */
  private notePayload(chunk: string | Uint8Array): void {
    if (chunk.length > 0)
      this.openLine = typeof chunk === "string" ? !chunk.endsWith("\n") : chunk.at(-1) !== 10;
  }

  noteInPlaceOutput(): void {
    this.openLine = true;
  }

  setFooter(lines: ReadonlyArray<string>): void {
    this.footerLines = [...lines];
    if (this.paintFullTail(lines) || this.enteringFullTail || this.openLine) return;
    if (lines.length === 0) {
      this.inline.release();
      return;
    }
    this.inline.paint(lines);
  }

  clearFooter(): void {
    this.footerLines = [];
    if (this.paintFullTail([]) || this.enteringFullTail || this.openLine) return;
    this.inline.paint([]);
  }

  /** Paints the full-tail footer when full-tail owns the terminal; false leaves the footer to the inline painter. */
  private paintFullTail(lines: ReadonlyArray<string>): boolean {
    if (this.fullTail === undefined && !this.leavingFullTail) return false;
    const session = this.paintableFullTail();
    if (session !== undefined) paintFullTailFooter(session, lines, this.width, this.height);
    return true;
  }

  requestLive(): void {
    const renderer = this.liveFullTail()?.renderer;
    if (renderer !== undefined) requestFullTailRegion(renderer);
  }

  dropLive(): void {
    const renderer = this.liveFullTail()?.renderer;
    if (renderer !== undefined) dropFullTailRegion(renderer);
  }

  resize(width: number, height: number): void {
    this.liveFullTail()?.renderer.resize(width, height);
    this.applyResize(width, height);
  }

  private applyResize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.options.onResize?.(width, height);
  }

  /** The full-tail renderer, unless it is being destroyed or OpenTUI already destroyed it. */
  private liveFullTail(): FullTailSession<TRenderer> | undefined {
    const session = this.fullTail;
    return this.leavingFullTail || session?.renderer.isDestroyed === true ? undefined : session;
  }

  /** The full-tail renderer, when it owns the terminal and may paint. */
  private paintableFullTail(): FullTailSession<TRenderer> | undefined {
    return this.fullTailSuspended ? undefined : this.liveFullTail();
  }

  enterFullTail(): Promise<void> {
    return this.transitions.run(async () => {
      if (this.fullTail !== undefined || this.enteringFullTail) return;
      this.enteringFullTail = true;
      this.inline.paint([]);
      try {
        this.fullTail = await acquireFullTail(this.options, this.deps, (width, height) => {
          this.applyResize(width, height);
        });
        if (this.footerLines.length > 0) {
          paintFullTailFooter(this.fullTail, this.footerLines, this.width, this.height);
        }
      } catch (cause) {
        const session = this.fullTail;
        this.fullTail = undefined;
        if (session !== undefined) await leaveFullTail(session).catch(recordOpenTuiSubstrateFailure);
        const drained = await this.deferred.drain();
        for (const source of drained) this.inline.commitAbove(source);
        if (this.footerLines.length > 0) this.inline.paint(this.footerLines);
        throw cause;
      } finally {
        this.enteringFullTail = false;
      }
    });
  }

  exitFullTail(): Promise<void> {
    return this.transitions.run(async () => {
      const session = this.fullTail;
      if (session === undefined) return;
      try {
        await this.closeFullTail(session);
      } finally {
        // Rows stay deferred until OpenTUI has restored the main screen; written earlier, they land in the alternate screen.
        const drained = await this.deferred.drain().finally(() => {
          this.leavingFullTail = false;
        });
        for (const source of drained) this.inline.commitAbove(source);
        if (this.footerLines.length > 0 && !this.openLine) this.inline.paint(this.footerLines);
      }
    });
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
      await this.transitions.run(async () => {
        const session = this.fullTail;
        if (session === undefined) return;
        await this.closeFullTail(session).finally(() => {
          this.leavingFullTail = false;
        });
      });
    } catch (cause) {
      recordOpenTuiSubstrateFailure(cause);
      throw cause;
    } finally {
      await this.deferred.clear();
    }
  }

  /** Destroys the renderer; rows keep deferring until the caller clears `leavingFullTail`. */
  private async closeFullTail(session: FullTailSession<TRenderer>): Promise<void> {
    this.leavingFullTail = true;
    try {
      await leaveFullTail(session);
    } finally {
      this.fullTail = undefined;
      this.fullTailSuspended = false;
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
