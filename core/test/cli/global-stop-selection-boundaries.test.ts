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

for (const argv of [["--service", ""], ["--service", "ssh-agent", "-s", ""], ["--service="]]) {
  test(`explicit empty selection ${JSON.stringify(argv)} never becomes full teardown`, async () => {
    // Given applied global state and native CLI input containing an empty selection.
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-empty-"));
    try {
      const harness = await globalTeardownHarness(dataRoot, {
        plan: globalPlanAt(AbsolutePath.make(join(dataRoot, "global"))),
      });
      const parsed = parseFlagsAndPositionals(argv, metaGlobalStopSpec.flags ?? {}, { strict: true });
      // When parsed input reaches the operation.
      const result = await Effect.runPromise(
        globalStop(globalStopOptionsFromInput(parsed)).pipe(Effect.provide(harness.layer), Effect.result),
      );
      // Then the whole request fails before mutation or lifecycle events.
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingExecError" } });
      expect(harness.calls).toEqual([]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}

test("explicit selection with entirely absent evidence succeeds unchanged", async () => {
  // Given no applied plan, owned runtime resource, or desired config.
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-absent-"));
  try {
    const harness = await globalTeardownHarness(dataRoot, { availability: Effect.succeed(false) });
    // When an explicit unknown service is requested.
    const result = await Effect.runPromise(
      globalStop({ services: ["missing"] }).pipe(Effect.provide(harness.layer), Effect.result),
    );
    // Then absence remains a successful observational no-op.
    expect(result).toMatchObject({ _tag: "Success", success: { outcome: "unchanged", servicesStopped: [] } });
    expect(harness.calls).toEqual([]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

for (const status of ["running", "exited", "created"]) {
  test(`selected ${status} container is removed without whole-global teardown`, async () => {
    // Given an applied service with an observed container in the selected state.
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-remove-"));
    try {
      const plan = globalPlanAt(AbsolutePath.make(join(dataRoot, "global")));
      const harness = await globalTeardownHarness(dataRoot, {
        plan,
        services: [
          {
            app: plan.id,
            appRoot: plan.root,
            providerId: plan.provider,
            service: ServiceName.make("ssh-agent"),
            containerId: "exact-container",
            status,
          },
        ],
      });
      // When the applied service is selected.
      const result = await Effect.runPromise(
        globalStop({ services: ["ssh-agent"] }).pipe(Effect.provide(harness.layer)),
      );
      // Then the observed removal path determines the successful receipt.
      expect(result.servicesStopped).toEqual(["ssh-agent"]);
      expect(harness.calls).toEqual(["list", "pre-global-stop", "removeObservedService", "post-global-stop"]);
      expect(harness.removed.map((service) => service.containerId)).toEqual(["exact-container"]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}
