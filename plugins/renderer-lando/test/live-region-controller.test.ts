import { describe, expect, test } from "bun:test";

import {
  type LiveRegionRendererLike,
  type OpenTuiLiveRegionModuleLike,
  OpenTuiLiveRegionUnavailableError,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";

type RenderableOptions = {
  readonly content?: string;
  readonly width?: number;
};

class FakeRenderable {
  readonly children: FakeRenderable[] = [];
  readonly content: string | undefined;
  readonly width: number | undefined;

  constructor(_context: unknown, options: RenderableOptions) {
    this.content = options.content;
    this.width = options.width;
  }

  add(child: FakeRenderable): void {
    this.children.push(child);
  }

  destroy(): void {}
}

type Fixture = ReturnType<typeof makeFixture>;

const makeFixture = () => {
  const calls: string[] = [];
  const commits: string[] = [];
  const fpsAssignments: number[] = [];
  const footerWidths: number[] = [];
  let destroyCount = 0;
  let liveRequestCount = 0;
  let targetFps = 60;
  let maxFps = 60;
  let screenMode: "split-footer" | "alternate-screen" | "main-screen" = "split-footer";
  let footerHeight = 1;
  let width = 80;

  const renderer: LiveRegionRendererLike = {
    root: {
      add: (child) => {
        if (!(child instanceof FakeRenderable)) throw new TypeError("Expected a fake footer renderable.");
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
      calls.push(`resize:${nextWidth}x${nextHeight}`);
    },
    get screenMode() {
      return screenMode;
    },
    set screenMode(value) {
      screenMode = value;
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
  } satisfies OpenTuiLiveRegionModuleLike<LiveRegionRendererLike>;

  return {
    calls,
    commits,
    fpsAssignments,
    footerWidths,
    module,
    renderer,
    state: () => ({ destroyCount, footerHeight, liveRequestCount, maxFps, screenMode, targetFps }),
  };
};

const createController = async (fixture: Fixture) =>
  createLiveRegionController(
    { stdout: process.stdout, width: 80, height: 24, footerHeight: 1 },
    {
      loadModule: async () => fixture.module,
      createRenderer: async () => fixture.renderer,
    },
  );

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

    controller.resize(42, 12);

    expect(fixture.calls.slice(-2)).toEqual(["resize:42x12", "footer:one|two"]);
    expect(fixture.footerWidths).toEqual([80, 42]);
    expect(fixture.state().footerHeight).toBe(2);
  });

  test("resets replay bookkeeping without discarding committed scrollback", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.commitScrollback("kept");

    controller.reset();

    expect(fixture.calls).toEqual(["scrollback:kept", "reset:true"]);
    expect(fixture.commits).toEqual(["kept"]);
  });

  test("enters and exits the alternate-screen full tail", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.enterFullTail();
    expect(fixture.state().screenMode).toBe("alternate-screen");
    controller.exitFullTail();

    expect(fixture.state().screenMode).toBe("split-footer");
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
});
