import { expect, test } from "bun:test";
import { type NativeInitTransport, runNativeInit } from "@lando/container-runtime/testing/native-init";
import { Effect } from "effect";

import {
  type PodmanMachineRunner,
  ensureMacOSPodmanMachine,
  ensureWindowsPodmanMachine,
  makeSystemPodmanMachineRunner,
} from "@lando/provider-lando";

import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";
import { makeLifecycleMachineName } from "./machine-lifecycle-name.ts";

const machinePlatform =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : undefined;
const podmanCommand = process.env.LANDO_TEST_PODMAN_COMMAND || "podman";

class MachineLifecyclePrerequisiteError extends Error {
  constructor() {
    super("Machine platform prerequisite was not enforced.");
    this.name = "MachineLifecyclePrerequisiteError";
  }
}

class MachineNativeInitTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineNativeInitTransportError";
  }
}

/**
 * Resolve an already-selected transport for the uniquely owned lifecycle machine.
 * Never uses the default connection and never invents a Windows unix socket path.
 */
const resolveOwnedMachineTransport = async (
  command: string,
  machineName: string,
  platform: "darwin" | "win32",
): Promise<NativeInitTransport> => {
  const proc = Bun.spawn([command, "machine", "inspect", machineName, "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new MachineNativeInitTransportError(
      `podman machine inspect ${machineName} failed: ${stderr || stdout}`,
    );
  }
  const parsed = JSON.parse(stdout) as unknown;
  const machine = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof machine !== "object" || machine === null) {
    throw new MachineNativeInitTransportError("machine inspect returned no machine object");
  }
  const connectionInfo =
    "ConnectionInfo" in machine &&
    typeof machine.ConnectionInfo === "object" &&
    machine.ConnectionInfo !== null
      ? machine.ConnectionInfo
      : undefined;

  if (platform === "win32") {
    const pipe =
      connectionInfo !== undefined &&
      "PodmanPipe" in connectionInfo &&
      typeof connectionInfo.PodmanPipe === "object" &&
      connectionInfo.PodmanPipe !== null &&
      "Path" in connectionInfo.PodmanPipe &&
      typeof connectionInfo.PodmanPipe.Path === "string"
        ? connectionInfo.PodmanPipe.Path
        : undefined;
    if (pipe !== undefined && pipe.length > 0 && !pipe.startsWith("/")) {
      return { kind: "api", provider: "podman", endpoint: pipe };
    }
    throw new MachineNativeInitTransportError(`Owned machine ${machineName} published no Windows API pipe`);
  }

  const socket =
    connectionInfo !== undefined &&
    "PodmanSocket" in connectionInfo &&
    typeof connectionInfo.PodmanSocket === "object" &&
    connectionInfo.PodmanSocket !== null &&
    "Path" in connectionInfo.PodmanSocket &&
    typeof connectionInfo.PodmanSocket.Path === "string"
      ? connectionInfo.PodmanSocket.Path
      : undefined;
  if (socket !== undefined && socket.length > 0) {
    return { kind: "api", provider: "podman", endpoint: socket };
  }
  throw new MachineNativeInitTransportError(`Owned machine ${machineName} published no host API socket`);
};

const runLifecycle = (
  runner: PodmanMachineRunner,
  createAndStart: Effect.Effect<void, unknown>,
  machineName: string,
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

        // Durable native-init proof on the uniquely owned machine before teardown.
        if (machinePlatform === undefined) throw new MachineLifecyclePrerequisiteError();
        const transport = yield* Effect.promise(() =>
          resolveOwnedMachineTransport(podmanCommand, machineName, machinePlatform),
        );
        if (transport.kind === "command" && transport.connection === "default") {
          throw new MachineNativeInitTransportError("refusing default connection for native-init");
        }
        if (machinePlatform === "win32" && transport.kind === "api" && transport.endpoint.startsWith("/")) {
          throw new MachineNativeInitTransportError("refusing Windows unix socket for native-init");
        }
        const nativeInit = yield* Effect.promise(() => runNativeInit({ transport }));
        yield* Effect.sync(() => {
          console.info("NATIVE_INIT_MACHINE_EVIDENCE", JSON.stringify({ machineName, ...nativeInit }));
          expect(nativeInit.cases.length).toBeGreaterThan(0);
          expect(nativeInit.outcome).toBe("passed");
          expect(nativeInit.cleanup).toBe("completed");
        });

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
    const machineName = makeLifecycleMachineName("managed");
    const runner = makeSystemPodmanMachineRunner(podmanCommand, machineName, machinePlatform);
    expect(await Effect.runPromise(runner.inspect)).toBe("missing");
    const ensureMachine =
      machinePlatform === "darwin" ? ensureMacOSPodmanMachine : ensureWindowsPodmanMachine;

    await runLifecycle(runner, ensureMachine(runner).pipe(Effect.asVoid), machineName);

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
    const machineName = makeLifecycleMachineName("system");
    const runner = makeSystemPodmanMachineRunner(podmanCommand, machineName, machinePlatform);
    expect(await Effect.runPromise(runner.inspect)).toBe("missing");

    await runLifecycle(runner, runner.create.pipe(Effect.andThen(runner.start)), machineName);

    expect(await Effect.runPromise(runner.inspect)).toBe("missing");
  },
  300_000,
);
