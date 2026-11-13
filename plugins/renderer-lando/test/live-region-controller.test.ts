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

    controller.commitScrollback("first\n");
    controller.setFooter(["building"]);
    controller.commitScrollback("second\n");
    controller.setFooter(["done"]);

    expectOrder(written(fixture), ["first", "building", "second", "done"]);
  });

  test("keeps carriage-return progress on one line and does not paint footer over it", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["executing composer  0ms"]);
    fixture.writes.length = 0;

    controller.commitScrollback("  0/108 [>---------------------------]   0%\r");
    controller.setFooter(["executing composer  400ms"]);
    controller.commitScrollback("  53/108 [=============>--------------]  49%\r");

    const text = written(fixture);
    expect(text).toContain("  0/108 [>---------------------------]   0%\r");
    expect(text).toContain("  53/108 [=============>--------------]  49%\r");
    expect(text.split("\n").filter((line) => line.includes("/108")).length).toBe(1);
  });

  test("clearFooter erases the inline status line", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["executing composer  400ms"]);
    fixture.writes.length = 0;

    controller.clearFooter();

    expect(written(fixture)).toContain(`${ESC}[`);
    expect(written(fixture)).toContain("J");
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
    controller.commitScrollback("retired output\n");

    expect(fixture.calls).toEqual([]);
    expect(written(fixture)).toBe("retired output\r\n");
    expect(written(fixture)).not.toMatch(new RegExp(`${ESC}\\[[0-9;]*[AJ]`));

    fixture.writes.length = 0;
    controller.setFooter(["restarted"]);

    expect(fixture.calls).not.toContain("screenMode:split-footer");
    expect(written(fixture)).toContain("restarted");
  });

  test("balances live requests and caps both frame rates at 30", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);

    controller.requestLive();
    controller.dropLive();

    expect(fixture.state().liveRequestCount).toBe(0);
    expect(fixture.fpsAssignments).toEqual([]);

    await controller.enterFullTail();
    controller.requestLive();
    controller.dropLive();

    expect(fixture.state().liveRequestCount).toBe(0);
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

    expect(written(fixture)).not.toContain("imperative message");
  });

  test("a resize repaints the footer without rewriting committed rows", async () => {
    // Given: the terminal owns committed rows, so a reflow must only touch the live footer.
    const fixture = makeFixture();
    const controller = await createController(fixture, {
      stdout: process.stdout,
      width: 8,
      height: 4,
      onResize: () => {
        controller.setFooter(["footer"]);
      },
    });
    controller.setFooter(["footer"]);
    for (const line of ["one", "two", "界界界", "123456789"]) controller.commitScrollback(`${line}\n`);
    fixture.writes.length = 0;

    // When
    fixture.emitResize(5, 4);
    fixture.emitResize(10, 4);

    // Then
    const painted = written(fixture);
    expect(painted).toContain("footer");
    for (const line of ["one", "two", "界界界", "123456789"]) expect(painted).not.toContain(line);
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
  });

  test("clearing the footer leaves the last live tree without rewriting it", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["app:start", "done"]);
    expect(written(fixture).split("app:start").length - 1).toBe(1);

    controller.setFooter([]);
    controller.commitScrollback("ready: app");

    expect(written(fixture).split("app:start").length - 1).toBe(1);
    expect(written(fixture)).toContain("ready: app");
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

  test("clears inline before full-tail acquisition and defers replacement paint", async () => {
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
    expect(written(fixture)).toBe(`\r${ESC}[1A${ESC}[J`);
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

// Transition steps wait only on promises the test holds, so one event-loop turn runs everything else first.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("LiveRegionController — OpenTUI terminal transitions", () => {
  test("exit keeps rows deferred until OpenTUI has restored the terminal", async () => {
    // Given
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    controller.commitScrollback("before close\n");
    fixture.writes.length = 0;
    const releaseClose = fixture.holdClose();

    // When
    const exiting = controller.exitFullTail();
    controller.commitScrollback("while closing\n");
    await nextTurn();

    // Then
    expect(fixture.state().destroyCount).toBe(1);
    expect(written(fixture)).toBe("");
    releaseClose();
    await exiting;
    expectOrder(written(fixture), ["before close", "while closing"]);
    await controller.dispose();
  });

  test("a terminal payload is written only after OpenTUI suspends the full tail", async () => {
    // Given
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    let releaseSuspend = (): void => {};
    fixture.renderer.suspend = () => {
      fixture.calls.push("suspend");
      return new Promise<void>((resolve) => {
        releaseSuspend = resolve;
      });
    };
    fixture.calls.length = 0;

    // When
    const writing = controller.suspendOutput("payload\n", () => {
      fixture.calls.push("stdout:payload");
    });
    await nextTurn();

    // Then
    expect(fixture.calls).toEqual(["suspend"]);
    releaseSuspend();
    await writing;
    expect(fixture.calls).toEqual(["suspend", "stdout:payload", "resume"]);
    await controller.dispose();
  });

  test.each(["suspend", "resume"] as const)(
    "a rejected %s leaves the full-tail footer painting",
    async (transition) => {
      // Given
      const fixture = makeFixture();
      const controller = await createController(fixture);
      await controller.enterFullTail();
      const failure = new Error(`${transition} failed`);
      fixture.renderer[transition] = () => Promise.reject(failure);

      // When
      const writing = controller.suspendOutput("payload\n", () => {});
      await expect(writing).rejects.toBe(failure);
      controller.setFooter(["after failure"]);

      // Then
      expect(fixture.footerText()).toBe("after failure");
      await controller.dispose();
    },
  );

  test("a payload during exit waits for the restore and never suspends the closing renderer", async () => {
    // Given
    const fixture = makeFixture();
    const controller = await createController(fixture);
    await controller.enterFullTail();
    const releaseClose = fixture.holdClose();
    const exiting = controller.exitFullTail();
    fixture.calls.length = 0;

    // When
    const writing = controller.suspendOutput("payload\n", () => {
      fixture.calls.push("stdout:payload");
    });
    await nextTurn();

    // Then
    expect(fixture.calls).toEqual([]);
    releaseClose();
    await Promise.all([exiting, writing]);
    expect(fixture.calls).toEqual(["stdout:payload"]);
    await controller.dispose();
  });
});
