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
});

describe("runObservationFromListState", () => {
  test("carries no health or exit code, which the list endpoint does not report", () => {
    expect(runObservationFromListState("running")).toEqual({ status: "running" });
    expect(runObservationFromListState("exited")).toEqual({ status: "exited" });
    expect(runObservationFromListState(undefined)).toEqual({ status: "unknown" });
  });
});
