import { describe, expect, test } from "bun:test";

import {
  ComposeFixtureContainerStateError,
  assertServiceContainerRunning,
} from "./compose-fixture-container-state.ts";

const captureStateError = (inspect: unknown, containerName: string): unknown => {
  try {
    assertServiceContainerRunning(inspect, containerName);
    return undefined;
  } catch (error) {
    if (error instanceof ComposeFixtureContainerStateError) return error;
    throw error;
  }
};

describe("assertServiceContainerRunning", () => {
  test("Given a running service container, when its inspect state is asserted, then the assertion succeeds", () => {
    const inspect: unknown = { State: { Running: true, Status: "running" } };

    assertServiceContainerRunning(inspect, "lando-example-web");
  });

  test("Given an exited service container, when its inspect state is asserted, then the observed state is reported", () => {
    const state = { Running: false, Status: "exited" };

    const error = captureStateError({ State: state }, "lando-example-web");

    expect(error).toBeInstanceOf(ComposeFixtureContainerStateError);
    if (!(error instanceof ComposeFixtureContainerStateError)) return;
    expect(error.containerName).toBe("lando-example-web");
    expect(error.observedState).toEqual(state);
    expect(error.message).toContain("lando-example-web");
    expect(error.message).toContain('"Status":"exited"');
  });

  test("Given a created service container, when its inspect state is asserted, then the observed state is reported", () => {
    const state = { Running: false, Status: "created" };

    const error = captureStateError({ State: state }, "lando-example-worker");

    expect(error).toBeInstanceOf(ComposeFixtureContainerStateError);
    if (!(error instanceof ComposeFixtureContainerStateError)) return;
    expect(error.containerName).toBe("lando-example-worker");
    expect(error.observedState).toEqual(state);
  });

  test("Given inspect data without State, when its state is asserted, then the missing state is reported", () => {
    const error = captureStateError({}, "lando-example-gateway");

    expect(error).toBeInstanceOf(ComposeFixtureContainerStateError);
    if (!(error instanceof ComposeFixtureContainerStateError)) return;
    expect(error.containerName).toBe("lando-example-gateway");
    expect(error.observedState).toBeUndefined();
    expect(error.message).toContain("observed State: undefined");
  });
});
