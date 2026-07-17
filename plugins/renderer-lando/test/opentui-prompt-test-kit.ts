import type { CliRenderer } from "@opentui/core";
import * as openTuiModule from "@opentui/core";
import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import type { EventListenerLike, SelectOptionLike } from "../src/opentui/prompt-driver-types.ts";
import {
  type OpenTuiModuleLike,
  type RendererLike,
  createOpenTuiPromptDriver,
} from "../src/opentui/prompt-driver.ts";

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>> & { clock: ManualClock };

const openTui = openTuiModule satisfies OpenTuiModuleLike<CliRenderer>;

export const createOpenTuiPromptTestKit = () => {
  const setups: TestSetup[] = [];

  const makeSetup = async (width = 60, height = 12): Promise<TestSetup> => {
    const clock = new ManualClock();
    const setup = { ...(await createTestRenderer({ width, height, clock })), clock };
    setups.push(setup);
    return setup;
  };

  const makeDriver = async (testSetup: TestSetup) =>
    createOpenTuiPromptDriver<CliRenderer>({
      loadModule: async () => openTui,
      createRenderer: async () => testSetup.renderer,
      startRenderer: () => {},
    });

  const basePrompt = {
    name: "flavor",
    type: "text",
    message: "Choose a flavor",
  };

  const flavors = [
    { value: "vanilla", label: "Vanilla" },
    { value: "chocolate", label: "Chocolate" },
    { value: "strawberry", label: "Strawberry" },
  ];

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

  const cleanup = (): void => {
    for (const testSetup of setups.splice(0)) {
      testSetup.renderer.destroy();
    }
  };

  return { basePrompt, cleanup, flavors, flushInput, makeDriver, makeSetup, openTui, waitForBuild };
};

class LifecycleTestRenderable {
  value = "answer";
  plainText = "answer";
  options: SelectOptionLike[] = [];

  add(): void {}

  focus(): void {}

  on<A extends ReadonlyArray<unknown>>(event: string, listener: EventListenerLike<A>): void {
    if (event === "enter") Reflect.apply(listener, undefined, []);
  }

  getSelectedIndex(): number {
    return 0;
  }

  setSelectedIndex(): void {}
}

const makeLifecycleModule = (
  renderer: RendererLike,
  Renderable: typeof LifecycleTestRenderable = LifecycleTestRenderable,
) =>
  ({
    createCliRenderer: async () => renderer,
    BoxRenderable: Renderable,
    TextRenderable: Renderable,
    InputRenderable: Renderable,
    TextareaRenderable: Renderable,
    SelectRenderable: Renderable,
    TabSelectRenderable: Renderable,
    InputRenderableEvents: { ENTER: "enter" },
    SelectRenderableEvents: { ITEM_SELECTED: "selected" },
    TabSelectRenderableEvents: { ITEM_SELECTED: "selected" },
  }) satisfies OpenTuiModuleLike;

export const makeDestroyFailureFixture = (cancel: boolean) => {
  let createAttempts = 0;
  const destroyFailure = new Error("renderer destroy failed");
  const renderer: RendererLike = {
    root: { add: () => {}, on: () => {} },
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
  const module = makeLifecycleModule(renderer);
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

export const makeAbortFixture = () => {
  class AbortTestRenderable extends LifecycleTestRenderable {
    override on<A extends ReadonlyArray<unknown>>(_event: string, _listener: EventListenerLike<A>): void {}
  }

  let cancelByKey = (): void => {};
  let markListenerAttached: (() => void) | undefined;
  const listenerAttached = new Promise<void>((resolve) => {
    markListenerAttached = resolve;
  });
  const cleanup = { listener: 0, renderer: 0, starts: 0 };
  const renderer: RendererLike = {
    root: { add: () => {}, on: () => {} },
    keyInput: {
      on: (_event, listener) => {
        cancelByKey = () => Reflect.apply(listener, undefined, [{ name: "escape" }]);
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
  const module = makeLifecycleModule(renderer, AbortTestRenderable);
  const driver = createOpenTuiPromptDriver({
    loadModule: async () => module,
    createRenderer: async () => renderer,
    startRenderer: () => {
      cleanup.starts += 1;
    },
  });
  return {
    cancelByKey: () => cancelByKey(),
    cleanup,
    driver,
    listenerAttached,
  };
};
