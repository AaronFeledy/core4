import { afterEach, describe, expect, test } from "bun:test";

import {
  LiveRegionController,
  type LiveRegionRendererLike,
  type OpenTuiLiveRegionModuleLike,
  OpenTuiLiveRegionUnavailableError,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";

afterEach(() => {
  resetOpenTuiSubstrateAvailabilityForTests();
});

type RenderableOptions = {
  readonly content?: string | FakeStyledText;
  readonly width?: number;
};

type FakeChunk = { readonly __isChunk: true; readonly text: string };

class FakeStyledText {
  constructor(readonly chunks: FakeChunk[]) {}
}

const fakeStyle = (input: string | FakeChunk): FakeChunk =>
  typeof input === "string" ? { __isChunk: true, text: input } : input;

class FakeRenderable {
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

type Fixture = ReturnType<typeof makeFixture>;

interface FakeRenderer extends LiveRegionRendererLike {
  externalOutputMode: "capture-stdout" | "passthrough";
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  setCursorPosition(x: number, y: number, visible: boolean): void;
  on(event: "resize", listener: () => void): FakeRenderer;
  off(event: "resize", listener: () => void): FakeRenderer;
}

const makeFixture = () => {
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

  const renderer: FakeRenderer = {
    root: {
      add: (child) => {
        if (!(child instanceof FakeRenderable)) throw new TypeError("Expected a fake footer renderable.");
        footers.push(child);
        const lines = child.children.map((line) => line.content ?? "");
        footerWidths.push(child.width ?? 0);
        calls.push(`footer:${lines.join("|")}`);
      },
    },
    writeToScrollback: (writer) => {
      const snapshot = writer({ width, renderContext: renderer });
      if (!(snapshot.root instanceof FakeRenderable)) {
        throw new TypeError("Expected a fake scrollback renderable.");
      }
      const text = snapshot.root.content ?? "";
      commits.push(text);
      calls.push(`scrollback:${text}`);
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
      calls.push(`resize:${nextWidth}x${nextHeight}`);
    },
    get screenMode() {
      return screenMode;
    },
    set screenMode(value) {
      if (screenMode === value) return;
      calls.push(`screenMode:${value}`);
      screenMode = value;
    },
    get externalOutputMode() {
      return externalOutputMode;
    },
    set externalOutputMode(value) {
      if (externalOutputMode === value) return;
      calls.push(`externalOutputMode:${value}`);
      externalOutputMode = value;
    },
    get terminalWidth() {
      return width;
    },
    get terminalHeight() {
      return height;
    },
    setCursorPosition: (x, y, visible) => {
      calls.push(`cursor:${x},${y}:${String(visible)}`);
    },
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
    resetSplitFooterForReplay: ({ clearSavedLines }) => {
      calls.push(`reset:${String(clearSavedLines)}`);
    },
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

const createController = async (fixture: Fixture) => {
  const controller = await createLiveRegionController(
    { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
    {
      loadModule: async () => fixture.module,
      createRenderer: async () => fixture.renderer,
    },
  );
  fixture.calls.length = 0;
  return controller;
};

describe("LiveRegionController", () => {
  test("preserves interleaved scrollback and footer update order without loss", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.commitScrollback("first");
    controller.setFooter(["building"]);
    controller.commitScrollback("second");
    controller.setFooter(["done"]);

    expect(fixture.calls).toEqual([
      "scrollback:first",
      "footer:building",
      "scrollback:second",
      "footer:done",
    ]);
    expect(fixture.commits).toEqual(["first", "second"]);
  });

  test("commits embedded LF as separate styled scrollback rows including semantic blanks", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.commitScrollback("\u001b[31mBuild failed\u001b[0m\n\nRemediation: Run lando setup");

    expect(fixture.commits).toEqual(["Build failed", "", "Remediation: Run lando setup"]);
  });

  test("retires an empty split footer and legally reactivates it for later lines", async () => {
    const fixture = makeFixture();
    const passthrough: string[] = [];
    const controller = new LiveRegionController(
      fixture.module,
      fixture.renderer,
      80,
      24,
      undefined,
      (chunk) => passthrough.push(chunk),
    );
    controller.setFooter(["building"]);
    fixture.calls.length = 0;

    controller.setFooter([]);
    controller.commitScrollback("retired output");

    expect(fixture.footers[0]?.destroyCount).toBe(1);
    expect(fixture.calls).toEqual(["externalOutputMode:passthrough", "screenMode:main-screen"]);
    expect(fixture.state()).toMatchObject({ screenMode: "main-screen" });
    expect(passthrough).toEqual(["retired output\n"]);

    controller.setFooter(["restarted"]);

    expect(fixture.calls).toEqual([
      "externalOutputMode:passthrough",
      "screenMode:main-screen",
      "screenMode:split-footer",
      "cursor:1,24:false",
      "externalOutputMode:capture-stdout",
      "footer:restarted",
    ]);
    expect(fixture.footers).toHaveLength(2);
    expect(fixture.state()).toMatchObject({ footerHeight: 1, screenMode: "split-footer" });
  });

  test("balances live requests and caps both frame rates at 30", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.requestLive();
    controller.dropLive();

    expect(fixture.renderer.liveRequestCount).toBe(0);
    expect(fixture.fpsAssignments.every((fps) => fps <= 30)).toBe(true);
    expect(fixture.state()).toMatchObject({ targetFps: 30, maxFps: 30 });
  });

  test("reflows the current footer from the resized width", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["one", "two"]);
    fixture.calls.length = 0;

    controller.resize(42, 12);

    expect(fixture.calls).toEqual([
      "resize:42x12",
      "reset:true",
      "externalOutputMode:passthrough",
      "cursor:1,12:false",
      "externalOutputMode:capture-stdout",
      "footer:one|two",
    ]);
    expect(fixture.footerWidths).toEqual([80, 42]);
    expect(fixture.state().footerHeight).toBe(2);
  });

  test("bounds the live footer to terminal rows while preserving its closing line", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(42, 3);

    controller.setFooter(["header", "one", "two", "three", "closing"]);

    expect(fixture.calls.at(-1)).toBe("footer:header|one|closing");
    expect(fixture.state().footerHeight).toBe(3);
  });

  test("destructively resets and semantically replays retained scrollback", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(8, 4);
    controller.setFooter(["footer"]);
    fixture.calls.length = 0;
    controller.commitScrollback("kept");

    controller.reset();

    expect(fixture.calls).toEqual([
      "scrollback:kept",
      "reset:true",
      "scrollback:kept",
      "externalOutputMode:passthrough",
      "cursor:1,4:false",
      "externalOutputMode:capture-stdout",
      "footer:footer",
    ]);
    expect(fixture.commits).toEqual(["kept", "kept"]);
  });

  test("destructive replay restores remembered imperative output exactly once", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(20, 5);
    controller.setFooter(["footer"]);
    controller.rememberScrollback("imperative message\n");
    fixture.calls.length = 0;

    controller.reset();

    expect(fixture.calls.filter((call) => call.startsWith("reset:"))).toEqual(["reset:true"]);
    expect(fixture.calls.filter((call) => call === "scrollback:imperative message")).toEqual([
      "scrollback:imperative message",
    ]);
  });

  test("replays only the bounded visible suffix across repeated resizes", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(8, 4);
    controller.setFooter(["footer"]);
    for (const line of ["one", "two", "three", "four", "five", "six"]) {
      controller.commitScrollback(line);
    }
    fixture.calls.length = 0;

    fixture.emitResize(9, 4);
    fixture.emitResize(10, 4);

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([
      "scrollback:four",
      "scrollback:five",
      "scrollback:six",
      "scrollback:four",
      "scrollback:five",
      "scrollback:six",
    ]);
    expect(fixture.calls.filter((call) => call.startsWith("reset:"))).toEqual(["reset:true", "reset:true"]);
  });

  test("accounts for display-cell wrapping when bounding the resize suffix", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(4, 4);
    controller.setFooter(["footer"]);
    controller.commitScrollback("old");
    controller.commitScrollback("123456789");
    fixture.calls.length = 0;

    fixture.emitResize(5, 4);

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual(["scrollback:123456789"]);
  });

  test("clips a partially visible wide-cell row to the available replay cells", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(4, 3);
    controller.setFooter(["footer"]);
    controller.commitScrollback("界界界");
    controller.commitScrollback("tail");
    fixture.calls.length = 0;

    fixture.emitResize(5, 3);

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([
      "scrollback:界界",
      "scrollback:tail",
    ]);
  });

  test("enters and exits full tail using legal output-mode ordering", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.enterFullTail();
    expect(fixture.state().screenMode).toBe("alternate-screen");
    controller.exitFullTail();

    expect(fixture.state().screenMode).toBe("split-footer");
    expect(fixture.calls).toEqual([
      "externalOutputMode:passthrough",
      "screenMode:alternate-screen",
      "screenMode:split-footer",
      "cursor:1,24:false",
      "externalOutputMode:capture-stdout",
    ]);
  });

  test("terminal resize resets replay state and restores committed output and footer", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.commitScrollback("kept");
    controller.setFooter(["building"]);
    fixture.calls.length = 0;

    fixture.emitResize();

    expect(fixture.calls).toEqual([
      "reset:true",
      "scrollback:kept",
      "externalOutputMode:passthrough",
      "cursor:1,12:false",
      "externalOutputMode:capture-stdout",
      "footer:building",
    ]);
  });

  test("flushes alternate-screen commits once in sequence after a pending resize", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(8, 4);
    controller.setFooter(["footer"]);
    controller.commitScrollback("before-a");
    controller.commitScrollback("before-b");
    controller.enterFullTail();
    fixture.calls.length = 0;

    for (const line of ["during-a", "during-b", "during-c", "during-d"]) {
      controller.commitScrollback(line);
    }
    fixture.emitResize(9, 4);
    controller.exitFullTail();

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([
      "scrollback:before-a",
      "scrollback:before-b",
      "scrollback:during-a",
      "scrollback:during-b",
      "scrollback:during-c",
      "scrollback:during-d",
    ]);
    fixture.calls.length = 0;

    fixture.emitResize(10, 4);

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([
      "scrollback:during-b",
      "scrollback:during-c",
      "scrollback:during-d",
    ]);
  });

  test("bounds deferred alternate-screen scrollback to a retained tail suffix", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.enterFullTail();
    fixture.calls.length = 0;

    const committed = 300;
    for (let index = 0; index < committed; index += 1) {
      controller.commitScrollback(`L${index}-${"x".repeat(1024)}`);
    }
    controller.exitFullTail();

    const retained = fixture.commits;
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(committed);
    expect(retained.at(-1)?.startsWith(`L${committed - 1}-`)).toBe(true);
    expect(retained.some((line) => line.startsWith("L0-"))).toBe(false);
    const indices = retained.map((line) => Number.parseInt(line.slice(1), 10));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(fixture.state().screenMode).toBe("split-footer");
  });

  test("drops a sole deferred line that alone exceeds the retention cap", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.enterFullTail();
    fixture.calls.length = 0;

    controller.commitScrollback("O".repeat(256 * 1024 + 100));
    controller.exitFullTail();

    expect(fixture.commits).toEqual([]);
    expect(fixture.state().screenMode).toBe("split-footer");
  });

  test("dispose removes the resize listener before destroying the renderer", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    expect(fixture.resizeListenerCount()).toBe(1);

    controller.dispose();

    expect(fixture.resizeListenerCount()).toBe(0);
    expect(fixture.state().destroyCount).toBe(1);
  });

  test("production renderer enters captured split-footer from a bottom-pinned cursor seed", async () => {
    const fixture = makeFixture();
    let config: Record<string, unknown> | undefined;
    const module = {
      ...fixture.module,
      createCliRenderer: async (nextConfig: Record<string, unknown>) => {
        config = nextConfig;
        fixture.renderer.externalOutputMode = "passthrough";
        fixture.calls.length = 0;
        return fixture.renderer;
      },
    } satisfies OpenTuiLiveRegionModuleLike<FakeRenderer>;

    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
      { loadModule: async () => module },
    );

    expect(config).toMatchObject({
      screenMode: "split-footer",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
    });
    expect(fixture.calls).toEqual(["cursor:1,24:false", "externalOutputMode:capture-stdout"]);
    controller.dispose();
  });

  test("destroys its renderer exactly once", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.dispose();
    controller.dispose();

    expect(fixture.state().destroyCount).toBe(1);
  });

  test("reports load and initialization failures with a typed fallback error", async () => {
    const fixture = makeFixture();
    const loadCause = new Error("native module missing");
    const initCause = new Error("unsupported terminal");

    const loadFailure = createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
      { loadModule: async () => Promise.reject(loadCause) },
    );
    expect(loadFailure).rejects.toEqual(new OpenTuiLiveRegionUnavailableError("load", loadCause));
    const initFailure = createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
      {
        loadModule: async () => fixture.module,
        createRenderer: async () => Promise.reject(initCause),
      },
    );
    expect(initFailure).rejects.toEqual(new OpenTuiLiveRegionUnavailableError("initialize", initCause));
  });

  test("destroys the renderer when the split-footer transition fails during initialization", async () => {
    const fixture = makeFixture();
    const transitionCause = new Error("split-footer transition failed");
    Object.defineProperty(fixture.renderer, "externalOutputMode", {
      configurable: true,
      get: () => "capture-stdout" as const,
      set: () => {
        throw transitionCause;
      },
    });

    const failure = createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
      { loadModule: async () => fixture.module, createRenderer: async () => fixture.renderer },
    );

    expect(failure).rejects.toEqual(new OpenTuiLiveRegionUnavailableError("initialize", transitionCause));
    expect(fixture.state().destroyCount).toBe(1);
  });
});
