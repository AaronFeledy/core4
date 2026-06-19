import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>>;

let setup: TestSetup | undefined;

const makeSetup = async (width = 60, height = 12): Promise<TestSetup> => {
  setup = await createTestRenderer({ width, height });
  return setup;
};

const makeDriver = async (testSetup: TestSetup) =>
  createOpenTuiPromptDriver({
    loadModule: async () => await import("@opentui/core"),
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  await testSetup.renderOnce();
};

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
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
    testSetup.mockInput.pressEnter();

    await expect(answer).resolves.toBe("2");
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
    testSetup.mockInput.pressEnter();
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
    testSetup2.mockInput.pressEnter();
    await expect(yesAnswer).resolves.toBe("y");
  });

  test("input accepts default on enter and typed values", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const defaultAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "vanilla" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressEnter();
    await expect(defaultAnswer).resolves.toBe("vanilla");

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const typedAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    await testSetup2.mockInput.typeText("mint");
    testSetup2.mockInput.pressEnter();
    await expect(typedAnswer).resolves.toBe("mint");
  });

  test("renders inline validation issue", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", issue: "must be lowercase" });
    await waitForBuild(testSetup);

    expect(testSetup.captureCharFrame()).toContain("must be lowercase");
    testSetup.mockInput.pressEnter();
    await answer;
  });

  test("cancels with PromptCancelledError on Ctrl-C or Escape", async () => {
    const testSetup = await makeSetup();
    const driver = await makeDriver(testSetup);

    const ctrlCAnswer = driver.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup);
    testSetup.mockInput.pressCtrlC();
    await expect(ctrlCAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });

    const testSetup2 = await makeSetup();
    const driver2 = await makeDriver(testSetup2);
    const escAnswer = driver2.readRaw({ prompt: basePrompt, mode: "normal" });
    await waitForBuild(testSetup2);
    testSetup2.mockInput.pressEscape();
    await expect(escAnswer).rejects.toMatchObject({ name: "PromptCancelledError" });
  });

  test("survives test renderer resize and still resolves", async () => {
    const testSetup = await makeSetup(40, 8);
    const driver = await makeDriver(testSetup);

    const answer = driver.readRaw({ prompt: basePrompt, mode: "normal", defaultRaw: "resized" });
    await waitForBuild(testSetup);
    testSetup.resize(80, 16);
    await testSetup.renderOnce();
    testSetup.mockInput.pressEnter();

    await expect(answer).resolves.toBe("resized");
  });

  test("declines secret and multiselect before creating a renderer", async () => {
    let created = false;
    const driver = createOpenTuiPromptDriver({
      loadModule: async () => await import("@opentui/core"),
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
});
