import { expect, test } from "bun:test";

import type { ServiceRunObservation, ServiceState } from "@lando/sdk/schema";

import { reconcileReadinessState, serviceStateOf } from "../../src/operations/connection-state.ts";

test.each([
  [{ status: "running" }, "running"],
  [{ status: "running", health: "unhealthy" }, "running"],
  [{ status: "paused" }, "paused"],
  [{ status: "restarting" }, "restarting"],
  [{ status: "absent" }, "stopped"],
  [{ status: "created" }, "stopped"],
  [{ status: "exited", exitCode: 3 }, "stopped"],
  [{ status: "dead" }, "stopped"],
  [{ status: "removing" }, "stopped"],
  [{ status: "unknown" }, "unknown"],
] as const satisfies ReadonlyArray<readonly [ServiceRunObservation, ServiceState]>)(
  "projects the %j observation as %s",
  (run, expected) => {
    expect(serviceStateOf(run)).toBe(expected);
  },
);

test.each([
  ["ready", { status: "running" }, "ready"],
  ["running", { status: "running" }, "running"],
  ["completed", { status: "exited", exitCode: 0 }, "completed"],
  ["restarting", { status: "exited", exitCode: 1 }, "restarting"],
  ["running", { status: "exited", exitCode: 1 }, "stopped"],
  ["ready", { status: "paused" }, "paused"],
  ["ready", { status: "unknown" }, "unknown"],
] as const satisfies ReadonlyArray<readonly [ServiceState, ServiceRunObservation, ServiceState]>)(
  "reconciles readiness %s with the %j observation as %s",
  (readiness, run, expected) => {
    expect(reconcileReadinessState(readiness, run)).toBe(expected);
  },
);
