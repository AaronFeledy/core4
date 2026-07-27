/**
 * Characterization test — pins CURRENT `core/src/interaction/interactive-driver.ts`
 * `resolveInteractivePromptDriver` degrade behavior before Wave 2+ replaces the
 * static `@lando/renderer-lando` package import with a descriptor-provided
 * loader reached through the same `gate.importRendererPlugin` seam. These
 * assertions describe the OBSERVABLE gate/degrade contract that must survive
 * that swap unchanged.
 *
 * PRE-EXISTING COVERAGE (do not duplicate — reused as-is, nothing removed):
 * `core/test/cli/prompts/interactive-driver.test.ts` already pins, exhaustively:
 *   - non-TTY / `--yes` / `--no-interactive` / `CI` truthy / `LANDO_NO_OPENTUI_PROMPTS=1`
 *     all degrade to `undefined` WITHOUT calling `importRendererPlugin`.
 *   - a rejecting `importRendererPlugin` (loader import failure) degrades to `undefined`.
 *   - a resolved module missing `loadInteractivePromptDriver` degrades to `undefined`.
 *   - the happy path: the gate passes, the injected fake module's driver loads,
 *     and `readRaw` forwards through the adapter.
 *   - `PromptCancelledError` translation, generic failure passthrough, AbortSignal
 *     forwarding, the one-time degradation latch (first `OpenTuiPromptUnavailableError`
 *     degrades + emits exactly one debug notice + suppresses further import attempts),
 *     and that cancellation does NOT latch degradation.
 * `core/test/interaction/service.test.ts` only imports
 * `resetInteractivePromptDegradationForTest` for its own unrelated setup/teardown.
 *
 * This file adds ONLY the gate nuances that existing coverage does not exercise:
 * the `CI` truthiness parsing edge cases (`"false"`/`"0"` do NOT count as CI, only
 * `"true"` and other non-empty/non-"false"/non-"0" values do), the exact-match
 * requirement on `LANDO_NO_OPENTUI_PROMPTS` (only the literal `"1"` opts out), and
 * that an omitted `gate.env` falls back to the real `process.env`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  resetInteractivePromptDegradationForTest,
  resolveInteractivePromptDriver,
} from "../../../src/interaction/interactive-driver.ts";

const fakePlugin = (readRaw: (request: unknown, signal?: AbortSignal) => Promise<string>) => ({
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

describe('resolveInteractivePromptDriver — CI env truthiness parsing (contract: only a non-empty, non-"false", non-"0" CI value counts as CI)', () => {
  test('CI="false" does NOT degrade (proceeds to load the driver)', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { CI: "false" },
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
    expect(await driver?.readRaw(promptRequest)).toBe("answer");
  });

  test('CI="0" does NOT degrade (proceeds to load the driver)', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { CI: "0" },
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
  });

  test('CI="" (empty string) does NOT degrade', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { CI: "" },
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
  });

  test('any other non-empty CI value (e.g. "1") DOES degrade without importing the plugin', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { CI: "1" },
      importRendererPlugin: importShouldNotRun,
    });
    expect(driver).toBeUndefined();
  });
});

describe('resolveInteractivePromptDriver — LANDO_NO_OPENTUI_PROMPTS (contract: only the exact literal "1" opts out)', () => {
  test('LANDO_NO_OPENTUI_PROMPTS="0" does NOT degrade', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { LANDO_NO_OPENTUI_PROMPTS: "0" },
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
  });

  test('LANDO_NO_OPENTUI_PROMPTS="true" does NOT degrade (only the literal "1" matches)', async () => {
    const driver = await resolveInteractivePromptDriver({
      isTTY: true,
      env: { LANDO_NO_OPENTUI_PROMPTS: "true" },
      importRendererPlugin: async () => fakePlugin(async () => "answer"),
    });
    expect(driver).toBeDefined();
  });
});

describe("resolveInteractivePromptDriver — gate.env default (contract: an omitted env falls back to process.env)", () => {
  test("omitting gate.env reads CI from the real process.env", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";
    try {
      const driver = await resolveInteractivePromptDriver({
        isTTY: true,
        importRendererPlugin: importShouldNotRun,
      });
      expect(driver).toBeUndefined();
    } finally {
      if (previousCi === undefined) process.env.CI = undefined;
      else process.env.CI = previousCi;
    }
  });
});
