import { afterEach, describe, expect, test } from "bun:test";

import {
  resetInteractivePromptDegradationForTest,
  resolveInteractivePromptDriver,
} from "../../../src/interaction/interactive-driver.ts";
import { PromptCancelledError } from "../../../src/recipes/prompts/driver.ts";
import { collectPrompts, createBufferedPromptIO } from "../../../src/recipes/prompts/index.ts";

const fakePlugin = (readRaw: (request: unknown) => Promise<string>) => ({
  loadInteractivePromptDriver: async () => ({ readRaw }),
});

const promptRequest = {
  prompt: { name: "name", type: "text", message: "Name" },
  mode: "normal",
} as const;

const importShouldNotRun = () => {
  throw new Error("plugin import must not be attempted when a gate rejects");
};

afterEach(() => {
  resetInteractivePromptDegradationForTest();
});

describe("resolveInteractivePromptDriver — deterministic bypass gates (S3)", () => {
  test("non-TTY returns undefined without importing the plugin", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: false,
      env: {},
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });

  test("--yes returns undefined without importing the plugin", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      yes: true,
      env: {},
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });

  test("--no-interactive returns undefined without importing the plugin", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      nonInteractive: true,
      env: {},
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });

  test("CI environment returns undefined without importing the plugin", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { CI: "true" },
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });

  test("LANDO_NO_OPENTUI_PROMPTS=1 escape hatch returns undefined", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { LANDO_NO_OPENTUI_PROMPTS: "1" },
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });
});

describe("resolveInteractivePromptDriver — load + adaptation", () => {
  test("passes the gate and returns an adapted driver that forwards readRaw", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
    expect(await driver?.readRaw(promptRequest)).toBe("answer");
  });

  test("translates a plugin cancellation (name PromptCancelledError) to the core error", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () =>
        fakePlugin(async () => {
          const error = new Error("cancelled");
          error.name = "PromptCancelledError";
          throw error;
        }),
    });
    await expect(driver?.readRaw(promptRequest)).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("re-throws a generic driver failure unchanged (runtime falls back to line input)", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () =>
        fakePlugin(async () => {
          throw new Error("driver declines secret");
        }),
    });
    await expect(driver?.readRaw(promptRequest)).rejects.toThrow("driver declines secret");
    await expect(driver?.readRaw(promptRequest)).rejects.not.toBeInstanceOf(PromptCancelledError);
  });

  test("import failure degrades to undefined", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () => {
        throw new Error("no native opentui in compiled binary");
      },
    });
    expect(driver).toBeUndefined();
  });

  test("first OpenTUI init failure falls back, emits one debug notice, and suppresses later attempts", async () => {
    let importAttempts = 0;
    let readAttempts = 0;
    const notices: string[] = [];
    const io = createBufferedPromptIO({ inputs: ["line-answer"], isTTY: true });
    const gate = {
      isTTY: true,
      env: {},
      debug: (message: string) => notices.push(message),
      importRendererPlugin: async () => {
        importAttempts += 1;
        return fakePlugin(async () => {
          readAttempts += 1;
          const error = new Error("native renderer init failed");
          error.name = "OpenTuiPromptUnavailableError";
          throw error;
        });
      },
    };
    const driver = await resolveInteractivePromptDriver(gate);

    const answers = await collectPrompts({
      prompts: [{ name: "name", type: "text", message: "App name" }],
      io,
      ...(driver === undefined ? {} : { interactiveDriver: driver }),
    });
    await expect(
      driver?.readRaw({ prompt: { name: "later", type: "text", message: "Later" }, mode: "normal" }),
    ).rejects.toMatchObject({ name: "OpenTuiPromptUnavailableError" });
    const laterDriver = await resolveInteractivePromptDriver(gate);

    expect(answers.name).toBe("line-answer");
    expect(io.stdout()).toBe("App name: ");
    expect(laterDriver).toBeUndefined();
    expect(importAttempts).toBe(1);
    expect(readAttempts).toBe(1);
    expect(notices).toEqual(["OpenTUI prompts degraded to line input for this process."]);
  });

  test("cancellation does not latch OpenTUI degradation", async () => {
    let importAttempts = 0;
    const gate = {
      isTTY: true,
      env: {},
      importRendererPlugin: async () => {
        importAttempts += 1;
        return fakePlugin(async () => {
          const error = new Error("cancelled");
          error.name = "PromptCancelledError";
          throw error;
        });
      },
    };
    const driver = await resolveInteractivePromptDriver(gate);

    await expect(driver?.readRaw(promptRequest)).rejects.toBeInstanceOf(PromptCancelledError);
    expect(await resolveInteractivePromptDriver(gate)).toBeDefined();
    expect(importAttempts).toBe(2);
  });

  test("missing loader export degrades to undefined", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () => ({}),
    });
    expect(driver).toBeUndefined();
  });
});
