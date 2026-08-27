import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type OpenTuiLiveRegionModuleLike,
  OpenTuiLiveRegionUnavailableError,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import {
  type FakeRenderer,
  createCapturingStdout,
  createTestLiveRegionController as createController,
  makeLiveRegionFixture as makeFixture,
} from "./live-region-test-kit.ts";

const ESC = String.fromCharCode(27);

const makeSpoolProbe = () => {
  const lines: string[] = [];
  let removed = false;
  return {
    spool: {
      append: (line: string) => lines.push(line),
      readLines: async () => lines,
      remove: async () => {
        removed = true;
      },
    },
    wasRemoved: () => removed,
  };
};

const written = (fixture: ReturnType<typeof makeFixture>): string => fixture.writes.join("");

const expectOrder = (text: string, parts: ReadonlyArray<string>): void => {
  let cursor = 0;
  for (const part of parts) {
    const index = text.indexOf(part, cursor);
    expect(index).toBeGreaterThanOrEqual(0);
    cursor = index + part.length;
  }
};

beforeEach(() => {
  resetLiveRegionModuleCacheForTests();
});

afterEach(() => {
  resetOpenTuiSubstrateAvailabilityForTests();
  resetLiveRegionModuleCacheForTests();
});

describe("LiveRegionController", () => {
  test("preserves interleaved scrollback and footer update order without loss", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.commitScrollback("first");
    controller.setFooter(["building"]);
    controller.commitScrollback("second");
    controller.setFooter(["done"]);

    expectOrder(written(fixture), ["first", "building", "second", "done"]);
  });

  test("commits embedded LF as separate styled scrollback rows including semantic blanks", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.commitScrollback("\u001b[31mBuild failed\u001b[0m\n\nRemediation: Run lando setup");

    const text = written(fixture);
    expect(text).toContain("Build failed");
    expect(text).toContain("Remediation: Run lando setup");
  });

  test("retires an empty split footer and legally reactivates it for later lines", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["building"]);
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    controller.setFooter([]);
    controller.commitScrollback("retired output");

    expect(fixture.calls).toEqual([]);
    expect(written(fixture)).toBe("retired output\n");
    expect(written(fixture)).not.toMatch(new RegExp(`${ESC}\\[[0-9;]*[AJ]`));

    fixture.writes.length = 0;
    controller.setFooter(["restarted"]);

    expect(fixture.calls).not.toContain("cursor:1,24:false");
    expect(fixture.calls).not.toContain("screenMode:split-footer");
    expect(written(fixture)).toContain("restarted");
  });

  test("balances live requests and caps both frame rates at 30", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.requestLive();
    controller.dropLive();

    expect(fixture.renderer.liveRequestCount).toBe(0);
    expect(fixture.fpsAssignments).toEqual([]);

    await controller.enterFullTail();
    controller.requestLive();
    controller.dropLive();

    expect(fixture.renderer.liveRequestCount).toBe(0);
    expect(fixture.fpsAssignments.every((fps) => fps <= 30)).toBe(true);
    expect(fixture.state()).toMatchObject({ targetFps: 30, maxFps: 30 });
  });

  test("reflows the current footer from the resized width", async () => {
    const fixture = makeFixture();
    const lines = ["one", "two"];
    const controller = await createController(fixture, {
      stdout: process.stdout,
      width: 80,
      height: 24,
      onResize: () => {
        controller.setFooter(lines);
      },
    });
    controller.setFooter(lines);
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    controller.resize(42, 12);

    expect(fixture.calls).not.toContain("cursor:1,12:false");
    expect(fixture.calls).not.toContain("reset:true");
    expect(written(fixture)).toContain("one");
    expect(written(fixture)).toContain("two");
  });

  test("bounds the live footer to terminal rows while preserving its closing line", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    controller.resize(42, 3);

    controller.setFooter(["header", "one", "two", "three", "closing"]);

    expect(fixture.calls.at(-1)).toBe("footer:header|one|closing");
  });

  test("destructively resets and semantically replays retained scrollback", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(8, 4);
    controller.setFooter(["footer"]);
    fixture.calls.length = 0;
    controller.commitScrollback("kept");

    await controller.reset();

    expect(fixture.calls).not.toContain("cursor:1,4:false");
    expect(fixture.calls).not.toContain("reset:true");
    expect(written(fixture)).toContain("kept");
  });

  test("destructive replay restores remembered imperative output exactly once", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(20, 5);
    controller.setFooter(["footer"]);
    controller.rememberScrollback("imperative message\n");
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    await controller.reset();

    expect(fixture.calls.filter((call) => call.startsWith("reset:"))).toEqual([]);
    expect(written(fixture)).not.toContain("imperative message");
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

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([]);
    expect(fixture.calls.filter((call) => call.startsWith("reset:"))).toEqual([]);
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

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([]);
    expect(fixture.calls).not.toContain("reset:true");
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

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([]);
    expect(fixture.calls).not.toContain("reset:true");
  });

  test("enters and exits full tail using legal output-mode ordering", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    await controller.enterFullTail();
    expect(fixture.state().screenMode).toBe("alternate-screen");
    await controller.exitFullTail();

    expect(fixture.state().screenMode).not.toBe("split-footer");
    expect(fixture.calls[0]).toBe("externalOutputMode:passthrough");
    expect(fixture.calls[1]).toBe("screenMode:alternate-screen");
    expect(fixture.calls).not.toContain("screenMode:split-footer");
    expect(fixture.calls).not.toContain("cursor:1,24:false");
  });

  test("exit full tail rewinds the inline tree instead of painting a duplicate", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["one", "two"]);
    fixture.writes.length = 0;

    await controller.enterFullTail();
    await controller.exitFullTail();

    const out = written(fixture);
    expect(out).toContain("one");
    expect(out).toMatch(new RegExp(`${ESC}\\[2A${ESC}\\[J`));
    expect(out.split("one").length - 1).toBe(1);
  });

  test("does not paint inline while full-tail acquisition is in flight", async () => {
    const fixture = makeFixture();
    let releaseRenderer: ((renderer: FakeRenderer) => void) | undefined;
    const pendingRenderer = new Promise<FakeRenderer>((resolve) => {
      releaseRenderer = resolve;
    });
    const controller = await createLiveRegionController(
      { stdout: createCapturingStdout(fixture.writes), width: 80, height: 24 },
      {
        loadModule: async () => fixture.module,
        createRenderer: async () => pendingRenderer,
      },
    );
    controller.setFooter(["one"]);
    fixture.writes.length = 0;
    const entering = controller.enterFullTail();
    controller.setFooter(["two"]);
    expect(written(fixture)).toBe("");
    releaseRenderer?.(fixture.renderer);
    await entering;
    expect(fixture.calls.some((call) => call.startsWith("footer:") && call.includes("two"))).toBe(true);
  });

  test("terminal resize resets replay state and restores committed output and footer", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.commitScrollback("kept");
    controller.setFooter(["building"]);
    fixture.calls.length = 0;

    fixture.emitResize();

    expect(fixture.calls).not.toContain("cursor:1,12:false");
    expect(fixture.calls).not.toContain("reset:true");
    expect(written(fixture)).toContain("kept");
  });

  test("flushes alternate-screen commits once in sequence after a pending resize", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.resize(8, 4);
    controller.setFooter(["footer"]);
    controller.commitScrollback("before-a");
    controller.commitScrollback("before-b");
    await controller.enterFullTail();
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    for (const line of ["during-a", "during-b", "during-c", "during-d"]) {
      controller.commitScrollback(line);
    }
    fixture.emitResize(9, 4);
    await controller.exitFullTail();

    expectOrder(written(fixture), ["during-a", "during-b", "during-c", "during-d"]);
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    fixture.emitResize(10, 4);

    expect(fixture.calls.filter((call) => call.startsWith("scrollback:"))).toEqual([]);
  });

  test("commits all deferred alternate-screen scrollback in arrival order exactly once", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    const committed = 300;
    for (let index = 0; index < committed; index += 1) {
      controller.commitScrollback(`L${index}-${"x".repeat(1024)}`);
    }
    await controller.exitFullTail();

    expectOrder(
      written(fixture),
      Array.from({ length: committed }, (_, index) => `L${index}-${"x".repeat(1024)}`),
    );
    expect(fixture.state().screenMode).not.toBe("split-footer");
  });

  test("commits a sole deferred line larger than the memory cap intact", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    fixture.calls.length = 0;
    fixture.writes.length = 0;

    const oversizedLine = "O".repeat(256 * 1024 + 100);
    controller.commitScrollback(oversizedLine);
    await controller.exitFullTail();

    expect(written(fixture)).toContain(oversizedLine);
    expect(fixture.state().screenMode).not.toBe("split-footer");
  });

  test("removes the deferred spool after exiting full tail", async () => {
    const fixture = makeFixture();
    const probe = makeSpoolProbe();
    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      {
        loadModule: async () => fixture.module,
        createRenderer: async () => fixture.renderer,
        spool: () => probe.spool,
      },
    );
    await controller.enterFullTail();
    for (let index = 0; index < 300; index += 1) {
      controller.commitScrollback(`L${index}-${"x".repeat(1024)}`);
    }

    await controller.exitFullTail();

    expect(probe.wasRemoved()).toBe(true);
  });

  test("removes the deferred spool when disposed during full tail", async () => {
    const fixture = makeFixture();
    const probe = makeSpoolProbe();
    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      {
        loadModule: async () => fixture.module,
        createRenderer: async () => fixture.renderer,
        spool: () => probe.spool,
      },
    );
    await controller.enterFullTail();
    for (let index = 0; index < 300; index += 1) {
      controller.commitScrollback(`L${index}-${"x".repeat(1024)}`);
    }

    await controller.dispose();

    expect(probe.wasRemoved()).toBe(true);
  });

  test("dispose removes the resize listener before destroying the renderer", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    expect(fixture.resizeListenerCount()).toBe(0);
    await controller.enterFullTail();
    expect(fixture.resizeListenerCount()).toBe(1);

    await controller.dispose();

    expect(fixture.resizeListenerCount()).toBe(0);
    expect(fixture.state().destroyCount).toBe(1);
  });

  test("production renderer enters captured split-footer without a forced bottom pin", async () => {
    const fixture = makeFixture();
    let config: Record<string, unknown> | undefined;
    const module = {
      ...fixture.module,
      createCliRenderer: async (nextConfig: Record<string, unknown>) => {
        config = nextConfig;
        fixture.calls.length = 0;
        return fixture.renderer;
      },
    } satisfies OpenTuiLiveRegionModuleLike<FakeRenderer>;

    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      { loadModule: async () => module },
    );

    expect(config).toBeUndefined();
    expect(fixture.calls).toEqual([]);
    await controller.dispose();
  });

  test("dispose leaves capture and split-footer before destroy without replaying scrollback", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.commitScrollback("kept");
    fixture.calls.length = 0;

    await controller.dispose();
    await controller.dispose();

    expect(fixture.calls).toEqual([]);
    expect(written(fixture)).toContain("kept");
    expect(fixture.state().destroyCount).toBe(0);
  });

  test("destroys its renderer exactly once", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();

    await controller.dispose();
    await controller.dispose();

    expect(fixture.state().destroyCount).toBe(1);
  });

  test("reports load and initialization failures with a typed fallback error", async () => {
    const fixture = makeFixture();
    const loadCause = new Error("native module missing");
    const initCause = new Error("unsupported terminal");

    const loadFailure = createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      { loadModule: async () => Promise.reject(loadCause) },
    );
    const loaded = await loadFailure;
    expect(loaded.enterFullTail()).rejects.toEqual(new OpenTuiLiveRegionUnavailableError("load", loadCause));
    const initFailure = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      {
        loadModule: async () => fixture.module,
        createRenderer: async () => Promise.reject(initCause),
      },
    );
    expect(initFailure.enterFullTail()).rejects.toEqual(
      new OpenTuiLiveRegionUnavailableError("initialize", initCause),
    );
  });

  test("does not force a post-create output-mode transition during initialization", async () => {
    const fixture = makeFixture();
    Object.defineProperty(fixture.renderer, "externalOutputMode", {
      configurable: true,
      get: () => "capture-stdout" as const,
      set: () => {
        throw new Error("split-footer transition failed");
      },
    });

    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24 },
      { loadModule: async () => fixture.module, createRenderer: async () => fixture.renderer },
    );

    expect(controller).toBeDefined();
    expect(fixture.state().destroyCount).toBe(0);
  });
});
