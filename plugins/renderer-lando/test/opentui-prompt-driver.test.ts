import { afterEach, describe, expect, test } from "bun:test";
import * as openTuiModule from "@opentui/core";
import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import {
  type OpenTuiModuleLike,
  type RendererLike,
  createOpenTuiPromptDriver,
} from "../src/opentui/prompt-driver.ts";

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>> & { clock: ManualClock };

const openTui = openTuiModule satisfies OpenTuiModuleLike<openTuiModule.CliRenderer>;

const setups: TestSetup[] = [];

const makeSetup = async (width = 60, height = 12): Promise<TestSetup> => {
  const clock = new ManualClock();
  const setup = { ...(await createTestRenderer({ width, height, clock })), clock };
  setups.push(setup);
  return setup;
};

const makeDriver = async (testSetup: TestSetup) =>
  createOpenTuiPromptDriver({
    loadModule: async () => openTui,
    createRenderer: async () => testSetup.renderer,
    startRenderer: () => {},
  });

const basePrompt = {
  name: "flavor",
  type: "text",
  message: "Choose a flavor",
};

const waitForBuild = async (testSetup: TestSetup): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await testSetup.renderOnce();
};

const flushInput = async (testSetup: TestSetup): Promise<void> => {
  testSetup.clock.advance(25);
  await Promise.resolve();
  await testSetup.renderOnce();
};

const makeDestroyFailureFixture = (cancel: boolean) => {
  class TestRenderable {
    value = "answer";
    plainText = "answer";

    add(): void {}

    focus(): void {}

    on(event: string, listener: (...args: ReadonlyArray<unknown>) => void): void {
      if (event === "enter") Reflect.apply(listener, undefined, []);
    }

    setSelectedIndex(): void {}
  }

  let createAttempts = 0;
  const destroyFailure = new Error("renderer destroy failed");
  const renderer: RendererLike = {
    root: {
      add: () => {},
      on: () => {},
    },
    keyInput: {
      on: (_event, listener) => {
        if (cancel) Reflect.apply(listener, undefined, [{ name: "escape" }]);
      },
    },
    width: 60,
    height: 12,
    destroy: async () => {
      throw destroyFailure;
    },
  };
  const module = {
    createCliRenderer: async () => renderer,
    BoxRenderable: TestRenderable,
    TextRenderable: TestRenderable,
    InputRenderable: TestRenderable,
    TextareaRenderable: TestRenderable,
    SelectRenderable: TestRenderable,
    TabSelectRenderable: TestRenderable,
    InputRenderableEvents: { ENTER: "enter" },
    SelectRenderableEvents: { ITEM_SELECTED: "selected" },
    TabSelectRenderableEvents: { ITEM_SELECTED: "selected" },
  } satisfies OpenTuiModuleLike;
  const driver = createOpenTuiPromptDriver({
    loadModule: async () => module,
    createRenderer: async () => {
      createAttempts += 1;
      return renderer;
    },
    startRenderer: () => {},
  });
  return { createAttempts: () => createAttempts, destroyFailure, driver };
};

const makeAbortFixture = () => {
  class TestRenderable {
    value = "answer";
    plainText = "answer";

    add(): void {}

    focus(): void {}

    on(): void {}

    setSelectedIndex(): void {}
  }

  let keyListener: ((...args: ReadonlyArray<unknown>) => void) | undefined;
  let markListenerAttached: (() => void) | undefined;
  const listenerAttached = new Promise<void>((resolve) => {
    markListenerAttached = resolve;
  });
  const cleanup = { listener: 0, renderer: 0, starts: 0 };
  const renderer: RendererLike = {
    root: {
      add: () => {},
      on: () => {},
    },
    keyInput: {
      on: (_event, listener) => {
        keyListener = listener;
        markListenerAttached?.();
      },
      off: () => {
        cleanup.listener += 1;
      },
    },
    width: 60,
    height: 12,
    destroy: async () => {
      cleanup.renderer += 1;
    },
  };
  const module = {
    createCliRenderer: async () => renderer,
    BoxRenderable: TestRenderable,
    TextRenderable: TestRenderable,
    InputRenderable: TestRenderable,
    TextareaRenderable: TestRenderable,
    SelectRenderable: TestRenderable,
    TabSelectRenderable: TestRenderable,
    InputRenderableEvents: { ENTER: "enter" },
    SelectRenderableEvents: { ITEM_SELECTED: "selected" },
    TabSelectRenderableEvents: { ITEM_SELECTED: "selected" },
  } satisfies OpenTuiModuleLike;
  const driver = createOpenTuiPromptDriver({
    loadModule: async () => module,
    createRenderer: async () => renderer,
    startRenderer: () => {
      cleanup.starts += 1;
    },
  });
  return {
    cancelByKey: () => {
      if (keyListener !== undefined) Reflect.apply(keyListener, undefined, [{ name: "escape" }]);
    },
    cleanup,
    driver,
    listenerAttached,
  };
};

afterEach(async () => {
  for (const testSetup of setups.splice(0)) {
    await testSetup.renderer.destroy();
  }
});

describe("OpenTUI prompt driver", () => {
  test("select returns a 1-based index after keyboard navigation", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "select" },
      mode: "normal",
      choices: [
        { value: "vanilla", label: "Vanilla" },
        { value: "chocolate", label: "Chocolate" },
      ],
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressArrow("down");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("2");
  });

  test("select pre-highlights prompt.default when defaultRaw is omitted", async () => {
    // tryDriverSelect (incl. `lando setup` provider pick) carries the intended
    // default on prompt.default and omits defaultRaw. Pressing Enter without
    // navigation must submit the resolved default's row, not index 0.
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const choices = [
      { value: "vanilla", label: "Vanilla" },
      { value: "chocolate", label: "Chocolate" },
      { value: "strawberry", label: "Strawberry" },
    ];
    const answer = driver.readRaw({
      prompt: { ...basePrompt, type: "select", choices, default: "strawberry" },
      mode: "normal",
      choices,
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("3");
  });

  test("confirm tab-select returns y or n", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const noAnswer = driver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "yes",
    });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressArrow("right");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(noAnswer).resolves.toBe("n");

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const yesAnswer = driver2.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "no",
    });
    await waitForBuild(testSetup2);
    testSetup2.mockInput.pressArrow("left");
    await flushInput(testSetup2);
    testSetup2.mockInput.pressEnter();
    await flushInput(testSetup2);
    await expect(yesAnswer).resolves.toBe("y");
  });

  test("confirm pre-selects No without an affirmative default", async () => {
    // No default: pressing Enter must NOT submit "y" — mirrors the line-based
    // [y/N]/(y/n) reader where blank input is never affirmative (security: plugin
    // trust and unverified tarball installs must not proceed on Enter alone).
    const noDefault = await makeSetup();
    const noDefaultDriver = await makeDriver(noDefault);
    const noDefaultAnswer = noDefaultDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
    });
    await waitForBuild(noDefault);
    noDefault.mockInput.pressEnter();
    await flushInput(noDefault);
    await expect(noDefaultAnswer).resolves.toBe("n");

    const falseDefault = await makeSetup();
    const falseDriver = await makeDriver(falseDefault);
    const falseAnswer = falseDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "false",
    });
    await waitForBuild(falseDefault);
    falseDefault.mockInput.pressEnter();
    await flushInput(falseDefault);
    await expect(falseAnswer).resolves.toBe("n");

    const yesDefault = await makeSetup();
    const yesDriver = await makeDriver(yesDefault);
    const yesAnswer = yesDriver.readRaw({
      prompt: { ...basePrompt, type: "confirm" },
      mode: "confirm",
      defaultRaw: "yes",
    });
    await waitForBuild(yesDefault);
    yesDefault.mockInput.pressEnter();
    await flushInput(yesDefault);
    await expect(yesAnswer).resolves.toBe("y");
  });

  test("input accepts default on enter and typed values", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const defaultAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "vanilla" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await expect(defaultAnswer).resolves.toBe("vanilla");

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const typedAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    await testSetup2.mockInput.typeText("mint");
    await flushInput(testSetup2);
    testSetup2.mockInput.pressEnter();
    await flushInput(testSetup2);
    await expect(typedAnswer).resolves.toBe("mint");
  });

  test("textarea submits multi-line answers", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: { ...basePrompt, type: "textarea" }, mode: "normal" });
    await waitForBuild(testSetup);
    await testSetup.mockInput.typeText("line one");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await testSetup.mockInput.typeText("line two");
    await flushInput(testSetup);
    testSetup.mockInput.pressEnter({ meta: true });
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("line one\nline two");
  });

  test("renders inline validation issue", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", issue: "must be lowercase" });
    await waitForBuild(testSetup);

    expect(testSetup.captureCharFrame()).toContain("must be lowercase");
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);
    await answer;
  });

  test("cancels with PromptCancelledError on Ctrl-C or Escape", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const ctrlCAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressCtrlC();
    await flushInput(testSetup);
    await expect(ctrlCAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const escAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    testSetup2.mockInput.pressEscape();
    await flushInput(testSetup2);
    await expect(escAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });
  });

  test("aborting an active read cancels and cleans the listener, renderer, and paint loop exactly once", async () => {
    const fixture = makeAbortFixture();
    const controller = new AbortController();
    let settled = false;
    const answer = fixture.driver
      .readRaw({ prompt: basePrompt, mode: "normal" }, controller.signal)
      .finally(() => {
        settled = true;
      });
    await fixture.listenerAttached;

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settledByAbort = settled;
    if (!settledByAbort) fixture.cancelByKey();

    await expect(answer).rejects.toMatchObject({ name: "PromptCancelledError" });
    expect(settledByAbort).toBe(true);
    expect(fixture.cleanup).toEqual({ listener: 1, renderer: 1, starts: 1 });
  });

  test("an already-aborted signal cancels before renderer creation", async () => {
    const controller = new AbortController();
    controller.abort();
    let createAttempts = 0;
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => openTui,
      createRenderer: async () => {
        createAttempts += 1;
        throw new Error("renderer must not be created");
      },
    });

    await expect(
      driver.readRaw({ prompt: basePrompt, mode: "normal" }, controller.signal),
    ).rejects.toMatchObject({
      name: "PromptCancelledError",
    });
    expect(createAttempts).toBe(0);
  });

  test("survives test renderer resize and still resolves", async () => {
    const testSetup = await makeSetup(40, 8);
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "resized" });
    await waitForBuild(testSetup);
    testSetup.resize(80, 16);
    await testSetup.renderOnce();
    testSetup.mockInput.pressEnter();
    await flushInput(testSetup);

    await expect(answer).resolves.toBe("resized");
  });

  test("declines secret and multiselect before creating a renderer", async () => {
    let created = false;
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => openTui,
      createRenderer: async () => {
        created = true;
        throw new Error("should not create renderer");
      },
    });

    await expect(
      driver.readRaw({ prompt: { ...basePrompt, type: "secret" }, mode: "normal" }),
    ).rejects.toThrow("driver declines secret");
    await expect(
      driver.readRaw({ prompt: { ...basePrompt, type: "multiselect" }, mode: "normal" }),
    ).rejects.toThrow("driver declines multiselect");
    expect(created).toBe(false);
  });

  test("missing-native and unsupported-terminal fixtures each latch without another attempt", async () => {
    const attempts = { load: 0, init: 0 };
    const request = { prompt: basePrompt, mode: "normal" } as const;
    const moduleDriver = createOpenTuiPromptDriver({
      loadModule: async () => {
        attempts.load += 1;
        throw new Error("Cannot find package @opentui/core-linux-x64");
      },
    });
    const rendererDriver = createOpenTuiPromptDriver({
      loadModule: async () => openTui,
      createRenderer: async () => {
        attempts.init += 1;
        throw new Error("Unsupported terminal: dumb");
      },
    });

    await expect(moduleDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(moduleDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(rendererDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    await expect(rendererDriver.readRaw(request)).rejects.toHaveProperty(
      "name",
      "OpenTuiPromptUnavailableError",
    );
    expect(attempts).toEqual({ load: 1, init: 1 });
  });

  test("preserves cancellation when destroy also fails and latches the destroy failure", async () => {
    const fixture = makeDestroyFailureFixture(true);

    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "PromptCancelledError",
    });
    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "OpenTuiPromptUnavailableError",
    });

    expect(fixture.createAttempts()).toBe(1);
  });

  test("preserves a successful answer while latching destroy failure", async () => {
    const fixture = makeDestroyFailureFixture(false);

    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).resolves.toBe("answer");
    await expect(fixture.driver.readRaw({ prompt: basePrompt, mode: "normal" })).rejects.toMatchObject({
      name: "OpenTuiPromptUnavailableError",
      cause: fixture.destroyFailure,
    });

    expect(fixture.createAttempts()).toBe(1);
  });
});
