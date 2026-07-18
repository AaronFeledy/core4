import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { CliCommandErrorEvent, CliCommandRunEvent } from "@lando/sdk/events";
import type { RenderEvent } from "@lando/sdk/events";
import type { LandoPluginContext } from "@lando/sdk/plugins";
import { NotifyConfig } from "@lando/sdk/schema";

import notify, { DEFAULT_NOTIFY_COMMAND_IDS, resolveNotifyCommandIds } from "../src/notify.ts";

const context = (published: Array<RenderEvent>): LandoPluginContext => ({
  id: "@lando/notify-lando",
  managedFiles: { pluginId: "@lando/notify-lando" },
  stateStore: { open: () => Effect.die("unused") },
  events: {
    publishRender: (event) =>
      Effect.sync(() => {
        published.push(event);
      }),
  },
});

const terminal = (kind: "run" | "error", overrides: Record<string, unknown> = {}) => {
  const input = {
    _tag: `cli-app:start-${kind}`,
    commandId: "app:start",
    argv: [],
    args: {},
    flags: {},
    cwd: "/app",
    invocationId: "outer",
    timestamp: "2026-07-18T00:00:00.000Z",
    durationMs: 15_000,
    exitCode: kind === "run" ? 0 : 1,
    ...(kind === "error" ? { failureTag: "ConfigError" } : {}),
    ...overrides,
  };
  return kind === "run"
    ? Schema.decodeUnknownSync(CliCommandRunEvent)(input)
    : Schema.decodeUnknownSync(CliCommandErrorEvent)(input);
};

const config = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(NotifyConfig)({ ...overrides });

describe("notify policy", () => {
  test("publishes exactly one success notification at the threshold boundary", async () => {
    // Given: an enabled outer default-family invocation at the exact threshold.
    const published: Array<RenderEvent> = [];
    const handler = notify(context(published), config());

    // When: the successful terminal event is handled.
    await Effect.runPromise(handler(terminal("run")));

    // Then: exactly one success notification is published.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ _tag: "notify.desktop", urgency: "success" });
  });

  test("publishes failure urgency when threshold zero qualifies an error", async () => {
    // Given: threshold zero and a failed outer invocation.
    const published: Array<RenderEvent> = [];
    const handler = notify(context(published), config({ thresholdMs: 0 }));

    // When: the failed terminal event is handled.
    await Effect.runPromise(handler(terminal("error", { durationMs: 0 })));

    // Then: one failure notification is published.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ _tag: "notify.desktop", urgency: "failure" });
  });

  test("ignores disabled, nested, below-threshold, and ineligible terminal events", async () => {
    // Given: handlers covering every policy rejection boundary.
    const published: Array<RenderEvent> = [];
    const disabled = notify(context(published), config({ enabled: false, thresholdMs: 0 }));
    const enabled = notify(context(published), config());

    // When: each rejected terminal event is handled.
    await Effect.runPromise(disabled(terminal("run")));
    await Effect.runPromise(enabled(terminal("run", { parentInvocationId: "parent" })));
    await Effect.runPromise(enabled(terminal("run", { durationMs: 14_999 })));
    await Effect.runPromise(
      enabled(terminal("run", { commandId: "meta:version", _tag: "cli-meta:version-run" })),
    );

    // Then: policy emits nothing; renderer capability remains presentation-owned.
    expect(published).toEqual([]);
  });

  test("deduplicates defaults before additional command ids in first-seen order", () => {
    // Given: repeated default and additional command ids.
    const notifyConfig = config({ commands: ["app:start", "meta:version", "meta:version", "app:stop"] });

    // When: the eligible family is resolved.
    const ids = resolveNotifyCommandIds(notifyConfig);

    // Then: defaults remain first and each id occurs once.
    expect(ids).toEqual([...DEFAULT_NOTIFY_COMMAND_IDS, "meta:version"]);
  });
});
