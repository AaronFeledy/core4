import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
} from "@lando/container-runtime/applied-state";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId } from "@lando/sdk/schema";

interface OpenCall {
  readonly key: string;
  readonly namespace?: string;
  readonly version: number;
  readonly codec: "json" | "binary" | object | undefined;
  readonly mode: number | undefined;
  readonly lock: "none" | "advisory" | undefined;
  readonly onCorrupt: "discard" | "quarantine" | "fail" | undefined;
  readonly onVersionMismatch: unknown;
  readonly hasDefault: boolean;
}

const recordingStateStore = (calls: OpenCall[]): PluginStateStore => ({
  open: (spec) => {
    calls.push({
      key: spec.key,
      ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
      version: spec.version,
      codec: spec.codec,
      mode: spec.mode,
      lock: spec.lock,
      onCorrupt: spec.onCorrupt,
      onVersionMismatch: spec.onVersionMismatch,
      hasDefault: spec.default !== undefined,
    });
    return Effect.die("recorded open");
  },
  withLock: (_key, body) => body,
});

describe("applied plan state layouts", () => {
  test("per-app layout preserves the namespaced file format", async () => {
    const calls: OpenCall[] = [];
    const store = makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });
    const appId = AppId.make("example");

    await Effect.runPromiseExit(store.loadAppliedPlan(recordingStateStore(calls), appId));

    expect(calls).toEqual([
      {
        key: "example.json",
        namespace: "applied-plans",
        version: 1,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "discard",
        onVersionMismatch: "discard",
        hasDefault: false,
      },
    ]);
    expect(appliedPlansDir("/tmp/plugin-state/")).toBe("/tmp/plugin-state/applied-plans");
    expect(appliedPlanPath("/tmp/plugin-state", appId)).toBe("/tmp/plugin-state/applied-plans/example.json");
  });

  test("record layout preserves the single-file collection format", async () => {
    const calls: OpenCall[] = [];
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromiseExit(store.listAppliedPlans(recordingStateStore(calls)));

    expect(calls).toEqual([
      {
        key: "applied-plans.json",
        version: 1,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "discard",
        onVersionMismatch: "discard",
        hasDefault: true,
      },
    ]);
  });
});
