import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
} from "@lando/container-runtime/applied-state";
import type { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";

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

describe("applied plan records", () => {
  const plan: AppPlan = {
    id: AppId.make("hooked"),
    name: "hooked",
    slug: "hooked",
    root: AbsolutePath.make("/tmp/hooked"),
    provider: ProviderId.make("lando"),
    services: {},
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    events: { "pre-stop": [{ step: "echo bye", source: "project", sourceIndex: 0, status: "active" }] },
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"), source: ".lando.yml", runtime: 4 },
    extensions: {},
  };
  const { events: _events, ...record } = plan;
  const writingStateStore = (written: unknown[]): PluginStateStore => ({
    open: <A, I>(_spec: PluginStateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
      Effect.succeed({
        path: AbsolutePath.make("/tmp/plugin-state/applied-plans.json"),
        get: Effect.succeed(null),
        set: (value: A) =>
          Effect.sync(() => {
            written.push(value);
          }),
        update: () => Effect.die("not used"),
        modify: <B>(f: (cur: A | null) => readonly [B, A]) =>
          Effect.sync(() => {
            const [result, next] = f(null);
            written.push(next);
            return result;
          }),
        remove: Effect.void,
        exists: Effect.succeed(false),
      }),
    withLock: (_key, body) => body,
  });

  test("the per-app layout persists the plan without its Landofile events", async () => {
    const written: unknown[] = [];
    const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });

    await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), plan));

    expect(written).toEqual([record]);
  });

  test("the record layout persists the plan without its Landofile events", async () => {
    const written: unknown[] = [];
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), plan));

    expect(written).toEqual([{ [plan.id]: record }]);
  });
});
