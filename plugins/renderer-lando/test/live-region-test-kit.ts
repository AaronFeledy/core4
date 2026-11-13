import { EventEmitter } from "node:events";

import {
  type LiveRegionController,
  type LiveRegionControllerOptions,
  type LiveRegionRendererLike,
  type OpenTuiLiveRegionModuleLike,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";

type RenderableOptions = {
  readonly content?: string | FakeStyledText;
  readonly width?: number;
  readonly height?: number;
};
type FakeChunk = { readonly __isChunk: true; readonly text: string };

class FakeStyledText {
  constructor(readonly chunks: FakeChunk[]) {}
}

const fakeStyle = (input: string | FakeChunk): FakeChunk =>
  typeof input === "string" ? { __isChunk: true, text: input } : input;

const plainText = (content: string | FakeStyledText | undefined): string | undefined =>
  typeof content === "string" ? content : content?.chunks.map((chunk) => chunk.text).join("");

export class FakeRenderable {
  readonly children: FakeRenderable[] = [];
  #content: FakeStyledText;
  width: number;
  height: number;
  destroyCount = 0;
  parent: FakeRenderable | undefined;
  /** Set once the renderable is mounted under the fake root, so later tree and content changes are observable. */
  onChange: (() => void) | undefined;

  constructor(_context: unknown, options: RenderableOptions) {
    this.#content = new FakeStyledText([fakeStyle(plainText(options.content) ?? "")]);
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
  }

  get content(): FakeStyledText {
    return this.#content;
  }

  set content(value: FakeStyledText) {
    this.#content = value;
    this.onChange?.();
  }

  get text(): string {
    return plainText(this.#content) ?? "";
  }

  add(child: FakeRenderable): void {
    this.children.push(child);
    child.parent = this;
    child.onChange = this.onChange;
    this.onChange?.();
  }

  /** Like OpenTUI, destroying a renderable detaches it from its parent. */
  destroy(): void {
    this.destroyCount += 1;
    this.onChange = undefined;
    const parent = this.parent;
    if (parent === undefined) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parent = undefined;
    parent.onChange?.();
  }
}

const footerRows = (footer: FakeRenderable): ReadonlyArray<string> =>
  footer.children.map((child) => child.text);

export interface FakeRenderer extends LiveRegionRendererLike {
  externalOutputMode: "capture-stdout" | "passthrough";
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  on(event: "resize", listener: () => void): FakeRenderer;
  off(event: "resize", listener: () => void): FakeRenderer;
}

export class CapturingStdout extends EventEmitter {
  columns = 80;
  rows = 24;

  constructor(private readonly writes: string[]) {
    super();
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }
}

export const createCapturingStdout = (writes: string[]): CapturingStdout => new CapturingStdout(writes);

export const createRecordingStdout = (
  columns = 80,
  rows = 24,
): { readonly stdout: CapturingStdout; readonly captured: () => string } => {
  const writes: string[] = [];
  const stdout = createCapturingStdout(writes);
  stdout.columns = columns;
  stdout.rows = rows;
  return {
    stdout,
    captured: () => writes.join(""),
  };
};

export const makeLiveRegionFixture = (onCall: (call: string) => void = () => {}) => {
  const calls: string[] = [];
  const writes: string[] = [];
  const fpsAssignments: number[] = [];
  const footers: FakeRenderable[] = [];
  const footerWidths: number[] = [];
  let destroyCount = 0;
  let liveRequestCount = 0;
  let targetFps = 60;
  let maxFps = 60;
  let screenMode: "split-footer" | "alternate-screen" | "main-screen" = "main-screen";
  let externalOutputMode: "capture-stdout" | "passthrough" = "capture-stdout";
  let width = 80;
  let height = 24;
  // Destroy restores the terminal asynchronously; `holdClose` keeps `closed` pending.
  let closed: Promise<void> = Promise.resolve();
  let capturedStdout: CapturingStdout | undefined;
  const resizeListeners = new Set<() => void>();
  const record = (call: string): void => {
    calls.push(call);
    onCall(call);
  };

  const renderer: FakeRenderer = {
    root: {
      add: (child) => {
        if (!(child instanceof FakeRenderable)) throw new TypeError("Expected a fake footer renderable.");
        footers.push(child);
        const recordFooter = (): void => {
          footerWidths.push(child.width);
          record(`footer:${footerRows(child).join("|")}`);
        };
        child.onChange = recordFooter;
        for (const row of child.children) row.onChange = recordFooter;
        recordFooter();
      },
    },
    requestLive: () => {
      liveRequestCount += 1;
    },
    dropLive: () => {
      liveRequestCount -= 1;
    },
    get targetFps() {
      return targetFps;
    },
    set targetFps(value: number) {
      targetFps = value;
      fpsAssignments.push(value);
    },
    get maxFps() {
      return maxFps;
    },
    set maxFps(value: number) {
      maxFps = value;
      fpsAssignments.push(value);
    },
    resize: (nextWidth, nextHeight) => {
      width = nextWidth;
      height = nextHeight;
      record(`resize:${nextWidth}x${nextHeight}`);
    },
    get screenMode() {
      return screenMode;
    },
    set screenMode(value) {
      if (screenMode === value) return;
      record(`screenMode:${value}`);
      screenMode = value;
    },
    get externalOutputMode() {
      return externalOutputMode;
    },
    set externalOutputMode(value) {
      if (externalOutputMode === value) return;
      record(`externalOutputMode:${value}`);
      externalOutputMode = value;
    },
    get terminalWidth() {
      return width;
    },
    get terminalHeight() {
      return height;
    },
    on: (event, listener) => {
      if (event === "resize") resizeListeners.add(listener);
      return renderer;
    },
    off: (event, listener) => {
      if (event === "resize") resizeListeners.delete(listener);
      return renderer;
    },
    destroy: () => {
      destroyCount += 1;
    },
    get closed() {
      return closed;
    },
    suspend: async () => {
      record("suspend");
    },
    resume: async () => {
      record("resume");
    },
  };

  const module = {
    createCliRenderer: async () => renderer,
    BoxRenderable: FakeRenderable,
    TextRenderable: FakeRenderable,
    StyledText: FakeStyledText,
    stringToStyledText: (content: string) => new FakeStyledText([fakeStyle(content)]),
    bold: fakeStyle,
    dim: fakeStyle,
    brightMagenta: fakeStyle,
    RGBA: {
      defaultForeground: () => ({ buffer: new Uint16Array(4) }),
      defaultBackground: () => ({ buffer: new Uint16Array(4) }),
      fromIndex: (index: number): { readonly intent: "indexed"; readonly slot: number } => ({
        intent: "indexed",
        slot: index,
      }),
    },
  } satisfies OpenTuiLiveRegionModuleLike<FakeRenderer>;

  const fixture = {
    calls,
    writes,
    fpsAssignments,
    footers,
    footerWidths,
    module,
    renderer,
    get stdout() {
      return capturedStdout;
    },
    set stdout(value: CapturingStdout | undefined) {
      capturedStdout = value;
    },
    state: () => ({ destroyCount, liveRequestCount, maxFps, screenMode, targetFps }),
    /** Keeps `renderer.closed` pending until the returned release runs. */
    holdClose: (): (() => void) => {
      let release: () => void = () => {};
      closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    emitResize: (nextWidth = 42, nextHeight = 12) => {
      width = nextWidth;
      height = nextHeight;
      for (const listener of [...resizeListeners]) listener();
      if (capturedStdout !== undefined) {
        capturedStdout.columns = nextWidth;
        capturedStdout.rows = nextHeight;
        capturedStdout.emit("resize");
      }
    },
    resizeListenerCount: () => resizeListeners.size,
    /** Rows of the footer currently mounted on the fake root. */
    footerText: (): string => {
      const footer = footers.at(-1);
      return footer === undefined || footer.destroyCount > 0 ? "" : footerRows(footer).join("|");
    },
  };
  return fixture;
};

export type LiveRegionFixture = ReturnType<typeof makeLiveRegionFixture>;

export const createTestLiveRegionController = async (
  fixture: LiveRegionFixture,
  options: LiveRegionControllerOptions = {
    stdout: process.stdout,
    width: 80,
    height: 24,
  },
): Promise<LiveRegionController<FakeRenderer>> => {
  resetLiveRegionModuleCacheForTests();
  const stdout = createCapturingStdout(fixture.writes);
  stdout.columns = options.width;
  stdout.rows = options.height;
  fixture.stdout = stdout;
  const controller = await createLiveRegionController(
    { ...options, stdout },
    {
      loadModule: async () => fixture.module,
      createRenderer: async () => fixture.renderer,
    },
  );
  fixture.calls.length = 0;
  return controller;
};
