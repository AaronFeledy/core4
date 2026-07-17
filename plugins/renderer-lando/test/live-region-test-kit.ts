import {
  type LiveRegionController,
  type LiveRegionControllerOptions,
  type LiveRegionRendererLike,
  type OpenTuiLiveRegionModuleLike,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";

type RenderableOptions = { readonly content?: string | FakeStyledText; readonly width?: number };
type FakeChunk = { readonly __isChunk: true; readonly text: string };

class FakeStyledText {
  constructor(readonly chunks: FakeChunk[]) {}
}

const fakeStyle = (input: string | FakeChunk): FakeChunk =>
  typeof input === "string" ? { __isChunk: true, text: input } : input;

export class FakeRenderable {
  readonly children: FakeRenderable[] = [];
  readonly content: string | undefined;
  readonly width: number | undefined;
  destroyCount = 0;

  constructor(_context: unknown, options: RenderableOptions) {
    this.content =
      typeof options.content === "string"
        ? options.content
        : options.content?.chunks.map((chunk) => chunk.text).join("");
    this.width = options.width;
  }

  add(child: FakeRenderable): void {
    this.children.push(child);
  }

  destroy(): void {
    this.destroyCount += 1;
  }
}

export interface FakeRenderer extends LiveRegionRendererLike {
  externalOutputMode: "capture-stdout" | "passthrough";
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  setCursorPosition(x: number, y: number, visible: boolean): void;
  on(event: "resize", listener: () => void): FakeRenderer;
  off(event: "resize", listener: () => void): FakeRenderer;
}

export const makeLiveRegionFixture = (onCall: (call: string) => void = () => {}) => {
  const calls: string[] = [];
  const commits: string[] = [];
  const fpsAssignments: number[] = [];
  const footers: FakeRenderable[] = [];
  const footerWidths: number[] = [];
  let destroyCount = 0;
  let liveRequestCount = 0;
  let targetFps = 60;
  let maxFps = 60;
  let screenMode: "split-footer" | "alternate-screen" | "main-screen" = "split-footer";
  let externalOutputMode: "capture-stdout" | "passthrough" = "capture-stdout";
  let footerHeight = 1;
  let width = 80;
  let height = 24;
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
        const lines = child.children.map((line) => line.content ?? "");
        footerWidths.push(child.width ?? 0);
        record(`footer:${lines.join("|")}`);
      },
    },
    writeToScrollback: (writer) => {
      const snapshot = writer({ width, renderContext: renderer });
      if (!(snapshot.root instanceof FakeRenderable)) {
        throw new TypeError("Expected a fake scrollback renderable.");
      }
      const text = snapshot.root.content ?? "";
      commits.push(text);
      record(`scrollback:${text}`);
    },
    requestLive: () => {
      liveRequestCount += 1;
    },
    dropLive: () => {
      liveRequestCount -= 1;
    },
    get liveRequestCount() {
      return liveRequestCount;
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
    setCursorPosition: (x, y, visible) => record(`cursor:${x},${y}:${String(visible)}`),
    on: (event, listener) => {
      if (event === "resize") resizeListeners.add(listener);
      return renderer;
    },
    off: (event, listener) => {
      if (event === "resize") resizeListeners.delete(listener);
      return renderer;
    },
    get footerHeight() {
      return footerHeight;
    },
    set footerHeight(value: number) {
      footerHeight = value;
    },
    resetSplitFooterForReplay: ({ clearSavedLines }) => record(`reset:${String(clearSavedLines)}`),
    destroy: () => {
      destroyCount += 1;
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
    red: fakeStyle,
    green: fakeStyle,
    yellow: fakeStyle,
    cyan: fakeStyle,
    brightMagenta: fakeStyle,
  } satisfies OpenTuiLiveRegionModuleLike<FakeRenderer>;

  return {
    calls,
    commits,
    fpsAssignments,
    footers,
    footerWidths,
    module,
    renderer,
    state: () => ({ destroyCount, footerHeight, liveRequestCount, maxFps, screenMode, targetFps }),
    emitResize: (nextWidth = 42, nextHeight = 12) => {
      width = nextWidth;
      height = nextHeight;
      for (const listener of [...resizeListeners]) listener();
    },
    resizeListenerCount: () => resizeListeners.size,
  };
};

export type LiveRegionFixture = ReturnType<typeof makeLiveRegionFixture>;

export const createTestLiveRegionController = async (
  fixture: LiveRegionFixture,
  options: LiveRegionControllerOptions = {
    stdout: process.stdout,
    width: 80,
    height: 24,
    footerHeight: 1,
  },
): Promise<LiveRegionController<FakeRenderer>> => {
  const controller = await createLiveRegionController(options, {
    loadModule: async () => fixture.module,
    createRenderer: async () => fixture.renderer,
  });
  fixture.calls.length = 0;
  return controller;
};
