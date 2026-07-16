import type { CliRenderer } from "@opentui/core";
import * as openTuiModule from "@opentui/core";
import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import { type OpenTuiModuleLike, createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";

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
