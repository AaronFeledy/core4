import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  globalStopOptionsFromInput,
  metaGlobalStopSpec,
} from "../../src/cli/command-specs/meta/global/stop.ts";
import { globalStop } from "../../src/cli/commands/meta/global-stop.ts";
import { parseFlagsAndPositionals } from "../../src/cli/compiled-argv.ts";
import { globalPlanAt, globalTeardownHarness } from "../_support/global-teardown-harness.ts";

test("global stop rejects an unknown selection before teardown or lifecycle events", async () => {
  // Given an applied global service and an unknown requested service.
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-selection-"));
  try {
    const plan = globalPlanAt(AbsolutePath.make(join(dataRoot, "global")));
    const harness = await globalTeardownHarness(dataRoot, { plan });
    // When the real command spec receives valid and unknown selections together.
    const result = await Effect.runPromise(
      globalStop(globalStopOptionsFromInput({ flags: { service: ["ssh-agent", "missing"] } })).pipe(
        Effect.provide(harness.layer),
        Effect.result,
      ),
    );
    // Then validation fails without mutating resources or publishing lifecycle events.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingExecError", tool: "meta:global:stop" },
    });
    expect(harness.calls).toEqual([]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

for (const stopFailure of [false, true]) {
  test(`global stop parses repeated --service/-s and publishes success events only on success=${!stopFailure}`, async () => {
    // Given an active applied service and the real repeatable CLI flag definitions.
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-flags-"));
    try {
      const plan = globalPlanAt(AbsolutePath.make(join(dataRoot, "global")));
      const harness = await globalTeardownHarness(dataRoot, {
        plan,
        stopFailure,
        services: [
          {
            app: plan.id,
            appRoot: plan.root,
            providerId: plan.provider,
            service: ServiceName.make("ssh-agent"),
            containerId: "ssh-container",
            status: "running",
          },
        ],
      });
      const parsed = parseFlagsAndPositionals(
        ["--service", "ssh-agent", "-s", "ssh-agent"],
        metaGlobalStopSpec.flags ?? {},
        { strict: true },
      );
      // When the native parser's input drives service-scoped stop.
      const result = await Effect.runPromise(
        globalStop(globalStopOptionsFromInput(parsed)).pipe(Effect.provide(harness.layer), Effect.result),
      );
      // Then duplicates stop once, teardown is bypassed, and failures omit the post event.
      expect(harness.calls).toEqual([
        "list",
        "pre-global-stop",
        "removeObservedService",
        ...(!stopFailure ? ["post-global-stop"] : []),
      ]);
      expect(result).toMatchObject(
        stopFailure
          ? { _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } }
          : { _tag: "Success", success: { outcome: "stopped", servicesStopped: ["ssh-agent"] } },
      );
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}

for (const online of [false, true]) {
  test(`selected stop reports unchanged without lifecycle events when no active container exists and online=${online}`, async () => {
    // Given applied state but no active container, with no materialized desired config.
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-noop-"));
    try {
      const plan = globalPlanAt(AbsolutePath.make(join(dataRoot, "global")));
      const harness = await globalTeardownHarness(dataRoot, {
        plan,
        availability: Effect.succeed(online),
      });
      // When the applied service is selected.
      const result = await Effect.runPromise(
        globalStop({ services: ["ssh-agent"] }).pipe(Effect.provide(harness.layer)),
      );
      // Then stop remains observational and emits no lifecycle events.
      expect(result).toEqual({
        app: "global",
        outcome: "unchanged",
        materialized: false,
        servicesStopped: [],
      });
      expect(harness.calls).toEqual(online ? ["list"] : []);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}
