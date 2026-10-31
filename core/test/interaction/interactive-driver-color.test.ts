import { expect, test } from "bun:test";

import { resolveInteractivePromptDriver } from "../../src/interaction/interactive-driver.ts";

test.each([
  [{}, false],
  [{ NO_COLOR: "" }, false],
  [{ NO_COLOR: "1" }, true],
  [{ NO_COLOR: "0" }, true],
  [{ TERM: "dumb" }, true],
] as const)("passes the resolved color opt-out for %j", async (env, expected) => {
  // Given
  let received: boolean | undefined;
  // When
  await resolveInteractivePromptDriver({
    isTTY: true,
    env,
    importRendererPlugin: async () => ({
      loadInteractivePromptDriver: async (options) => {
        received = options?.noColor;
        return { readRaw: async () => "answer" };
      },
    }),
  });
  // Then
  expect(received).toBe(expected);
});
