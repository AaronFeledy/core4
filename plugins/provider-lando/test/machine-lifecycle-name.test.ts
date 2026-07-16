import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type MachineSpawn, makeSystemPodmanMachineRunner } from "../src/setup.ts";
import { makeLifecycleMachineName } from "./machine-lifecycle-name.ts";

describe("native lifecycle acceptance machine names", () => {
  test("two managed lifecycle invocations receive different names", () => {
    const first = makeLifecycleMachineName("managed");
    const second = makeLifecycleMachineName("managed");

    expect(first).not.toBe(second);
  });

  test("managed and system names retain recognizable prefixes", () => {
    expect(makeLifecycleMachineName("managed")).toStartWith("lando-lifecycle-managed-");
    expect(makeLifecycleMachineName("system")).toStartWith("lando-lifecycle-system-");
  });

  test("the machine runner targets the generated name for the lifecycle", async () => {
    const machineName = makeLifecycleMachineName("managed");
    const calls: string[][] = [];
    const spawn: MachineSpawn = (argv) => {
      calls.push([...argv]);
      return { stdout: null, stderr: null, exited: Promise.resolve(0) };
    };
    const runner = makeSystemPodmanMachineRunner("podman", machineName, "darwin", spawn);

    await Effect.runPromise(
      runner.create.pipe(
        Effect.andThen(runner.start),
        Effect.andThen(runner.stop),
        Effect.andThen(runner.teardown),
      ),
    );

    expect(calls).toEqual([
      ["podman", "machine", "init", "--import-native-ca", machineName],
      ["podman", "machine", "start", "--update-connection=false", machineName],
      ["podman", "machine", "stop", machineName],
      ["podman", "machine", "rm", "--force", machineName],
    ]);
  });
});
