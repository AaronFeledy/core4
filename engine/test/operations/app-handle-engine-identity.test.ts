import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppPlacementError } from "@lando/sdk/errors";
import { type AppPlan, type EngineIdentity, appIdentityKey } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, type Layer, Result, Stream } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { execApp } from "../../src/operations/exec.ts";
import { infoApp } from "../../src/operations/info.ts";
import { logsAppForTarget } from "../../src/operations/logs.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { plan as basePlan, makeHarness, web } from "./start-progress-topology-support.ts";

const identity = (host: string): EngineIdentity => ({
  fingerprint: host,
  endpoint: `unix:///${host}/podman.sock`,
});

const plan: AppPlan = {
  ...basePlan,
  identity: { appRoot: basePlan.root, ownerKey: appIdentityKey("owner", basePlan.root) },
};
const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

type Harness = ReturnType<typeof makeHarness>;

const testProvider = (current?: EngineIdentity): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  id: String(plan.provider),
  exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  execStream: () => Stream.make({ exitCode: 0 }),
  inspect: (serviceTarget) =>
    Effect.succeed({
      app: serviceTarget.app,
      service: serviceTarget.service,
      providerId: plan.provider,
      status: "running",
      publications: { status: "unknown" },
    }),
  logs: () => Stream.empty,
  ...(current === undefined ? {} : { engineIdentity: current }),
});

const recording = (base: RuntimeProviderShape) => {
  const calls: string[] = [];
  const provider = new Proxy(base, {
    get(source, property, receiver) {
      const value = Reflect.get(source, property, receiver);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            calls.push(String(property));
            return (value as (...inner: ReadonlyArray<unknown>) => unknown).apply(source, [...args]);
          }
        : value;
    },
  });
  return { provider, calls };
};

const harnessFor = (current?: EngineIdentity, selected?: RuntimeProviderShape) => {
  const recorded = { ...plan, engineIdentity: identity("first") };
  const { provider, calls } = recording(selected ?? testProvider(current));
  const harness = makeHarness({
    plannedApp: plan,
    appliedPlans: [recorded],
    selectProvider: () => Effect.succeed(provider),
    resolveAppliedPlan: () => Effect.succeed(recorded),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan: recorded }),
  });
  return { harness, calls, recorded };
};

type Operation = {
  readonly name: string;
  readonly run: () => Effect.Effect<unknown, unknown, Layer.Success<Harness["layer"]>>;
};

const operations: ReadonlyArray<Operation> = [
  { name: "start", run: () => startAppForTarget(undefined, target) },
  { name: "stop", run: () => stopAppForTarget(undefined, target) },
  { name: "restart", run: () => restartApp({}, target) },
  { name: "rebuild", run: () => rebuildApp({}, target) },
  { name: "destroy", run: () => destroyAppForTarget(undefined, target) },
  { name: "info", run: () => infoApp(undefined, target) },
  { name: "exec", run: () => execApp({ service: String(web.name), command: ["true"] }, target) },
  { name: "logs", run: () => logsAppForTarget(undefined, target) },
];

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<Harness["layer"]>>, harness: Harness) =>
  Effect.runPromise(effect.pipe(Effect.provide(harness.layer), Effect.result));

const dispose = (harness: Harness) => rmSync(harness.userDataRoot, { recursive: true, force: true });

describe("App handle operations judge the applied record, not the desired plan", () => {
  test.each(operations)(
    "$name refuses a record from another engine before any provider call",
    async (operation) => {
      const { harness, calls } = harnessFor(identity("second"));
      try {
        const outcome = await run(operation.run(), harness);
        if (!Result.isFailure(outcome)) throw new Error(`${operation.name} did not refuse`);
        expect(outcome.failure).toBeInstanceOf(AppPlacementError);
        if (outcome.failure instanceof AppPlacementError) {
          expect(outcome.failure.message).toContain(identity("first").endpoint);
          expect(outcome.failure.message).toContain(identity("second").endpoint);
        }
        expect(calls).toEqual([]);
      } finally {
        dispose(harness);
      }
    },
  );

  test.each(operations)("$name proceeds when the provider has no engine identity", async (operation) => {
    const { harness, calls } = harnessFor(undefined);
    try {
      const outcome = await run(operation.run(), harness);
      expect(outcome._tag).toBe("Success");
      // Proceeding means real provider work, which is what a missing identity allows.
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      dispose(harness);
    }
  });

  test("logs streams from the record that names the connected engine", async () => {
    const seen: Array<AppPlan | undefined> = [];
    const withLogs: RuntimeProviderShape = {
      ...testProvider(identity("first")),
      logs: (logTarget) => {
        seen.push(logTarget.plan);
        return Stream.empty;
      },
    };
    const { harness, recorded } = harnessFor(identity("first"), withLogs);
    try {
      const outcome = await run(logsAppForTarget(undefined, target), harness);
      expect(outcome._tag).toBe("Success");
      // The plan handed to the provider is the applied record, not the handle's desired plan.
      expect(seen).toEqual([recorded]);
    } finally {
      dispose(harness);
    }
  });
});
