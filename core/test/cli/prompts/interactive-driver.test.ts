import { describe, expect, test } from "bun:test";

import { resolveInteractivePromptDriver } from "../../../src/cli/prompts/interactive-driver.ts";
import { PromptCancelledError } from "../../../src/recipes/prompts/driver.ts";

const fakePlugin = (readRaw: (request: unknown) => Promise<string>) => ({
  loadInteractivePromptDriver: async () => ({ readRaw }),
});

const importShouldNotRun = () => {
  throw new Error("plugin import must not be attempted when a gate rejects");
};

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
    expect(await driver?.readRaw({})).toBe("answer");
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
    await expect(driver?.readRaw({})).rejects.toBeInstanceOf(PromptCancelledError);
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
    await expect(driver?.readRaw({})).rejects.toThrow("driver declines secret");
    await expect(driver?.readRaw({})).rejects.not.toBeInstanceOf(PromptCancelledError);
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

  test("missing loader export degrades to undefined", async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: {},
      importRendererPlugin: async () => ({}),
    });
    expect(driver).toBeUndefined();
  });
});
