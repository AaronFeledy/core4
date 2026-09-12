import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";

describe("update replacement handoff", () => {
  test("stores a schema-versioned receipt and consumes it exactly once", async () => {
    const stateStore = makeTestStateStore();
    const handoff = makeUpdateHandoff(stateStore.service);
    const result = {
      updatedCore: true,
      updatedPlugins: ["@lando/plugin-php"],
      pluginResults: [
        {
          kind: "plugin" as const,
          name: "@lando/plugin-php",
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          selector: "latest",
          status: "update" as const,
          reason: "selected" as const,
        },
      ],
      hasFailures: false,
    };

    const token = await Effect.runPromise(handoff.save(result));
    const first = await Effect.runPromise(handoff.consume(token));
    const second = await Effect.runPromise(handoff.consume(token));

    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first).toEqual(result);
    expect(second).toBeUndefined();
    expect(stateStore.snapshot().size).toBe(0);
  });
});
