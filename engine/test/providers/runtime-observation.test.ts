import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  liveInventoryObservable,
  observeRuntime,
  prepareTeardownOwners,
  workloadsProvablyStopped,
} from "../../src/providers/runtime-observation.ts";

const unavailable = new ProviderUnavailableError({
  providerId: "lando",
  operation: "getStatus",
  message: "Unknown runtime state",
  remediation: "Repair runtime access.",
});

test.each(["running", "idle", "unknown", "uninstalled"] as const)(
  "observation never launches a %s runtime",
  async (state) => {
    let preparations = 0;
    let statusReads = 0;
    const provider = {
      ...TestRuntimeProvider,
      isAvailable: Effect.succeed(state !== "uninstalled"),
      getStatus: Effect.sync(() => {
        statusReads++;
      }).pipe(
        Effect.andThen(
          state === "unknown"
            ? Effect.fail(unavailable)
            : Effect.succeed({ state: state === "running" ? ("running" as const) : ("idle" as const) }),
        ),
      ),
      ensureReady: Effect.sync(() => {
        preparations++;
      }),
    };
    const observation = await Effect.runPromise(observeRuntime(provider));
    expect(observation.kind).toBe(state === "unknown" || state === "uninstalled" ? "unavailable" : state);
    expect(liveInventoryObservable(observation)).toBe(state === "running");
    expect(workloadsProvablyStopped(observation)).toBe(state === "idle");
    expect(preparations).toBe(0);
    expect(statusReads).toBe(state === "uninstalled" ? 0 : 1);
    if (state === "unknown") expect(observation).toMatchObject({ error: unavailable });
  },
);

test.each(["idle", "unknown"] as const)(
  "preparation rejects an owner that remains %s after admission",
  async (state) => {
    let preparations = 0;
    const provider = {
      ...TestRuntimeProvider,
      getStatus: state === "idle" ? Effect.succeed({ state: "idle" as const }) : Effect.fail(unavailable),
      ensureReady: Effect.sync(() => {
        preparations++;
      }),
    };
    const result = await Effect.runPromise(prepareTeardownOwners([provider]).pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderUnavailableError",
        operation: state === "idle" ? "ensureReady" : "getStatus",
      },
    });
    expect(preparations).toBe(1);
  },
);
