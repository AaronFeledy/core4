import { describe, expect, test } from "bun:test";

import {
  runObservationFromInspectState,
  runObservationFromListState,
  runStatusFromEngineState,
} from "../src/run-observation.ts";

describe("runStatusFromEngineState", () => {
  test.each([
    ["running", "running"],
    ["paused", "paused"],
    ["restarting", "restarting"],
    ["removing", "removing"],
    ["created", "created"],
    ["configured", "created"],
    ["initialized", "created"],
    ["exited", "exited"],
    ["stopped", "exited"],
    ["dead", "dead"],
    [" Running ", "running"],
    ["stopping", "unknown"],
    ["absent", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const)("maps engine spelling %j to %s", (raw, expected) => {
    expect(runStatusFromEngineState(raw)).toBe(expected);
  });
});

describe("runObservationFromInspectState", () => {
  test("keeps health only on a running container", () => {
    expect(runObservationFromInspectState({ Status: "running", Health: { Status: "unhealthy" } })).toEqual({
      status: "running",
      health: "unhealthy",
    });
    expect(runObservationFromInspectState({ Status: "paused", Health: { Status: "healthy" } })).toEqual({
      status: "paused",
    });
    expect(runObservationFromInspectState({ Status: "exited", Health: { Status: "healthy" } })).toEqual({
      status: "exited",
    });
  });

  test("ignores a health verdict the contract does not name", () => {
    expect(runObservationFromInspectState({ Status: "running", Health: { Status: "none" } })).toEqual({
      status: "running",
    });
  });

  test("keeps the exit code only for an exited container", () => {
    expect(runObservationFromInspectState({ Status: "exited", ExitCode: 17 })).toEqual({
      status: "exited",
      exitCode: 17,
    });
    expect(runObservationFromInspectState({ Status: "dead", ExitCode: 137 })).toEqual({
      status: "dead",
    });
    for (const Status of ["created", "restarting", "running", "paused"]) {
      expect(runObservationFromInspectState({ Status, ExitCode: 0 })).not.toHaveProperty("exitCode");
    }
  });

  test("lets Status override the boolean flags and falls back to them without it", () => {
    expect(runObservationFromInspectState({ Status: "paused", Running: true })).toEqual({ status: "paused" });
    expect(runObservationFromInspectState({ Running: true })).toEqual({ status: "running" });
    expect(runObservationFromInspectState({ Running: true, Paused: true })).toEqual({ status: "paused" });
    expect(runObservationFromInspectState({ Running: true, Restarting: true })).toEqual({
      status: "restarting",
    });
    expect(runObservationFromInspectState({ Running: false, ExitCode: 3 })).toEqual({
      status: "unknown",
    });
  });

  test("is unknown without state evidence or with an unrecognized spelling", () => {
    expect(runObservationFromInspectState(undefined)).toEqual({ status: "unknown" });
    expect(runObservationFromInspectState({})).toEqual({ status: "unknown" });
    expect(runObservationFromInspectState({ Status: "stopping", Running: true })).toEqual({
      status: "unknown",
    });
  });

  test("drops a non-integer exit code instead of publishing it", () => {
    expect(runObservationFromInspectState({ Status: "exited", ExitCode: 1.5 })).toEqual({ status: "exited" });
  });

  describe("healthCheckedAt", () => {
    // Docker writes UTC with nanoseconds; Podman's compat inspect writes a local offset.
    const dockerRestart = {
      Status: "running",
      StartedAt: "2026-11-23T21:00:10.5Z",
      Health: {
        Status: "healthy",
        Log: [
          { Start: "2026-11-23T20:59:50.1Z", End: "2026-11-23T20:59:50.3Z" },
          { Start: "2026-11-23T21:00:11.000000001Z", End: "2026-11-23T21:00:11.200000002Z" },
          { Start: "2026-11-23T21:00:21.000000001Z", End: "2026-11-23T21:00:21.300000003Z" },
        ],
      },
    };

    test("is the end of the newest check in the current run, in UTC", () => {
      expect(runObservationFromInspectState(dockerRestart)).toEqual({
        status: "running",
        health: "healthy",
        healthCheckedAt: "2026-11-23T21:00:21.300Z",
      });
      expect(
        runObservationFromInspectState({
          Status: "running",
          StartedAt: "2026-11-23T15:00:10.5-06:00",
          Health: {
            Status: "unhealthy",
            Log: [{ Start: "2026-11-23T15:00:11.1-06:00", End: "2026-11-23T15:00:11.4-06:00" }],
          },
        }),
      ).toMatchObject({ health: "unhealthy", healthCheckedAt: "2026-11-23T21:00:11.400Z" });
    });

    test("is absent right after a restart, while only the previous run's checks are logged", () => {
      const restarted = {
        ...dockerRestart,
        StartedAt: "2026-11-23T21:05:00Z",
        Health: { Status: "starting", Log: dockerRestart.Health.Log },
      };
      expect(runObservationFromInspectState(restarted)).toEqual({ status: "running", health: "starting" });
    });

    test("is absent without a parseable log, start time, or running verdict", () => {
      const without = (state: Parameters<typeof runObservationFromInspectState>[0]) =>
        runObservationFromInspectState(state);
      expect(without({ ...dockerRestart, Health: { Status: "healthy", Log: [] } })).not.toHaveProperty(
        "healthCheckedAt",
      );
      expect(without({ ...dockerRestart, Health: { Status: "healthy", Log: null } })).not.toHaveProperty(
        "healthCheckedAt",
      );
      expect(without({ ...dockerRestart, StartedAt: undefined })).not.toHaveProperty("healthCheckedAt");
      expect(
        without({
          ...dockerRestart,
          Health: { Status: "healthy", Log: [{ Start: "2026-11-23T21:00:11Z", End: "" }] },
        }),
      ).not.toHaveProperty("healthCheckedAt");
      expect(without({ ...dockerRestart, Status: "paused" })).toEqual({ status: "paused" });
      expect(without({ ...dockerRestart, Health: { ...dockerRestart.Health, Status: "none" } })).toEqual({
        status: "running",
      });
    });
  });
});

describe("runObservationFromListState", () => {
  test("carries no health or exit code, which the list endpoint does not report", () => {
    expect(runObservationFromListState("running")).toEqual({ status: "running" });
    expect(runObservationFromListState("exited")).toEqual({ status: "exited" });
    expect(runObservationFromListState(undefined)).toEqual({ status: "unknown" });
  });
});
