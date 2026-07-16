import { expect, test } from "bun:test";
import { Effect } from "effect";

import {
  type PodmanMachineRunner,
  ensureMacOSPodmanMachine,
  ensureWindowsPodmanMachine,
  makeSystemPodmanMachineRunner,
} from "@lando/provider-lando";

import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const machinePlatform =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : undefined;
const podmanCommand = process.env.LANDO_TEST_PODMAN_COMMAND || "podman";

class MachineLifecyclePrerequisiteError extends Error {
  constructor() {
    super("Machine platform prerequisite was not enforced.");
    this.name = "MachineLifecyclePrerequisiteError";
  }
}

const runLifecycle = (
  runner: PodmanMachineRunner,
  createAndStart: Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          runner.inspect.pipe(
            Effect.flatMap((status) => (status === "missing" ? Effect.void : runner.teardown)),
            Effect.orDie,
          ),
        );
        yield* createAndStart;
        yield* runner.inspect.pipe(
          Effect.flatMap((status) => Effect.sync(() => expect(status).toBe("running"))),
        );
        yield* runner.stop;
        yield* runner.inspect.pipe(
          Effect.flatMap((status) => Effect.sync(() => expect(status).toBe("stopped"))),
        );
        yield* runner.start;
        yield* runner.inspect.pipe(
          Effect.flatMap((status) => Effect.sync(() => expect(status).toBe("running"))),
        );
      }),
    ),
  );

const managedEligibility = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE === "1",
    reason: "LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE=1 is required",
  },
  { available: machinePlatform !== undefined, reason: "native macOS or Windows host is required" },
]);

test.skipIf(!managedEligibility.available)(
  liveIntegrationTestName("managed machine start stop destroy", managedEligibility),
  async () => {
    if (machinePlatform === undefined) throw new MachineLifecyclePrerequisiteError();
    const runner = makeSystemPodmanMachineRunner(podmanCommand, "lando-lifecycle-managed", machinePlatform);
    expect(await Effect.runPromise(runner.inspect)).toBe("missing");
    const ensureMachine =
      machinePlatform === "darwin" ? ensureMacOSPodmanMachine : ensureWindowsPodmanMachine;

    await runLifecycle(runner, ensureMachine(runner).pipe(Effect.asVoid));

    expect(await Effect.runPromise(runner.inspect)).toBe("missing");
  },
  300_000,
);

const systemEligibility = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE === "1",
    reason: "LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE=1 is required",
  },
  { available: machinePlatform !== undefined, reason: "native macOS or Windows host is required" },
]);

test.skipIf(!systemEligibility.available)(
  liveIntegrationTestName("system Podman machine start stop destroy", systemEligibility),
  async () => {
    if (machinePlatform === undefined) throw new MachineLifecyclePrerequisiteError();
    const runner = makeSystemPodmanMachineRunner(podmanCommand, "lando-lifecycle-system", machinePlatform);
    expect(await Effect.runPromise(runner.inspect)).toBe("missing");

    await runLifecycle(runner, runner.create.pipe(Effect.andThen(runner.start)));

    expect(await Effect.runPromise(runner.inspect)).toBe("missing");
  },
  300_000,
);
