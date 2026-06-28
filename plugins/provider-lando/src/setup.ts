import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { type Context, DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { HostPlatform } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import { type PodmanApiClient, makePodmanApiClient } from "./capabilities.ts";
import { type ArtifactDownload, ProviderBundleChecksumError } from "./runtime-bundle.ts";
import { installRuntimeBundle } from "./runtime-extract.ts";

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

const PROVIDER_ID = "lando";
const MINIMUM_PODMAN_VERSION = "4.9.0";

const currentHostPlatform = (): HostPlatform =>
  process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32";

export class PodmanNotInstalledError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: "Podman is not installed or is not available on PATH.",
      remediation: `Install Podman >= ${MINIMUM_PODMAN_VERSION} and rerun \`lando setup\`.`,
      cause,
    });
  }
}

export class PodmanSocketUnreachableError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: "The Podman API socket is not reachable.",
      remediation: "Run `systemctl --user start podman.socket` and rerun `lando setup`.",
      cause,
    });
  }
}

export class PodmanMachinePrerequisiteError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: "Podman machine prerequisites are not available on this macOS host.",
      remediation:
        "Enable Apple's virtualization framework support, install the required Podman machine helper components, then rerun `lando setup`.",
      cause,
    });
  }
}

export class WindowsMachinePrerequisiteError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message:
        "Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required.",
      remediation:
        "Enable Hyper-V, WSL2, and Virtual Machine Platform in Windows Features, then run `wsl --install` and rerun `lando setup`.",
      cause,
    });
  }
}

export interface PodmanCommandRunner {
  readonly version: Effect.Effect<string, PodmanNotInstalledError>;
}

export type PodmanMachineStatus = "missing" | "stopped" | "running";

export interface PodmanMachineRunner {
  readonly inspect: Effect.Effect<PodmanMachineStatus, ProviderUnavailableError>;
  readonly create: Effect.Effect<void, ProviderUnavailableError>;
  readonly start: Effect.Effect<void, ProviderUnavailableError>;
  readonly stop: Effect.Effect<void, ProviderUnavailableError>;
  readonly upgrade: Effect.Effect<void, ProviderUnavailableError>;
  readonly teardown: Effect.Effect<void, ProviderUnavailableError>;
}

export interface RuntimeBundle {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface RuntimeBundleDownloader {
  readonly download: Effect.Effect<RuntimeBundle, ProviderUnavailableError>;
}

export interface SetupOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly podmanMachine?: PodmanMachineRunner;
  readonly platform?: HostPlatform;
  readonly socketPath?: string;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly artifactDownload?: ArtifactDownload;
  readonly stateDir?: string;
  readonly runtimeBinDir?: string;
  readonly eventService?: EventPublisher;
}

export interface SetupResult {
  readonly podmanVersion: string;
  readonly runtimeBundleVersion?: string;
  readonly runtimeBinDir?: string;
  readonly statePath?: string;
}

export const providerStatePath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/provider-lando/setup-state.json`;

const readText = (stream: ReadableStream<Uint8Array> | null) =>
  stream === null ? Promise.resolve("") : new Response(stream).text();

export const makeSystemPodmanCommandRunner = (command = "podman"): PodmanCommandRunner => ({
  version: Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([command, "--version"], { stderr: "pipe", stdout: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        readText(proc.stdout),
        readText(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new PodmanNotInstalledError({ stderr, exitCode });
      }

      return stdout.trim();
    },
    catch: (cause) => (cause instanceof PodmanNotInstalledError ? cause : new PodmanNotInstalledError(cause)),
  }),
});

const machineFailure = (
  operation: string,
  cause: unknown,
  platform: HostPlatform,
): ProviderUnavailableError => {
  const output = typeof cause === "object" && cause !== null && "stderr" in cause ? cause.stderr : cause;
  if (
    platform === "win32" &&
    typeof output === "string" &&
    /virtualization|hyper-v|wsl|virtual machine platform|wsl2|wslapi|hypervisor/i.test(output)
  ) {
    return new WindowsMachinePrerequisiteError(cause);
  }
  if (
    platform === "darwin" &&
    typeof output === "string" &&
    /virtualization|vfkit|hypervisor|qemu|helper/i.test(output)
  ) {
    return new PodmanMachinePrerequisiteError(cause);
  }

  return new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: `Podman machine ${operation} failed.`,
    remediation: "Fix the Podman machine error and rerun `lando setup`.",
    cause,
  });
};

const readProcess = async (proc: ReturnType<typeof Bun.spawn>) => {
  const stdoutStream = proc.stdout instanceof ReadableStream ? proc.stdout : null;
  const stderrStream = proc.stderr instanceof ReadableStream ? proc.stderr : null;
  const [stdout, stderr, exitCode] = await Promise.all([
    readText(stdoutStream),
    readText(stderrStream),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const runMachineCommand = (
  command: string,
  args: ReadonlyArray<string>,
  operation: string,
  platform: HostPlatform,
) =>
  Effect.tryPromise({
    try: async () => {
      const result = await readProcess(Bun.spawn([command, ...args], { stderr: "pipe", stdout: "pipe" }));
      if (result.exitCode !== 0) {
        throw result;
      }
      return result.stdout;
    },
    catch: (cause) => machineFailure(operation, cause, platform),
  });

export const makeSystemPodmanMachineRunner = (
  command = "podman",
  machineName = "lando",
  platform: HostPlatform = currentHostPlatform(),
): PodmanMachineRunner => ({
  inspect: runMachineCommand(command, ["machine", "inspect", machineName], "inspect", platform).pipe(
    // Use `Effect.try` so a synchronous `podman machine inspect` parse failure still maps to a typed `ProviderUnavailableError`.
    Effect.flatMap((stdout) =>
      Effect.try({
        try: (): PodmanMachineStatus => {
          const machines = JSON.parse(stdout) as unknown;
          const machine = Array.isArray(machines) ? machines[0] : machines;
          if (typeof machine !== "object" || machine === null) {
            return "missing";
          }
          const state = "State" in machine ? machine.State : "state" in machine ? machine.state : undefined;
          return typeof state === "string" && /running/i.test(state) ? "running" : "stopped";
        },
        catch: (cause) =>
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "inspect",
            message: "Failed to parse `podman machine inspect` output.",
            remediation: "Verify the Podman machine state and rerun `lando setup`.",
            cause,
          }),
      }),
    ),
    // Treat exit code 125 as a missing machine only when stderr confirms that case; other 125 failures must surface.
    Effect.catchAll((cause) => {
      const raw = cause.cause;
      if (typeof raw !== "object" || raw === null) {
        return Effect.fail(cause);
      }
      const exitCode = "exitCode" in raw ? raw.exitCode : undefined;
      const stderr = "stderr" in raw && typeof raw.stderr === "string" ? raw.stderr : "";
      return exitCode === 125 && /not\s*(exist|found)|no such|cannot find/i.test(stderr)
        ? Effect.succeed("missing" as const)
        : Effect.fail(cause);
    }),
  ),
  create: runMachineCommand(command, ["machine", "init", machineName], "create", platform).pipe(
    Effect.asVoid,
  ),
  start: runMachineCommand(command, ["machine", "start", machineName], "start", platform).pipe(Effect.asVoid),
  stop: runMachineCommand(command, ["machine", "stop", machineName], "stop", platform).pipe(Effect.asVoid),
  upgrade: runMachineCommand(command, ["machine", "os", "apply", machineName], "upgrade", platform).pipe(
    Effect.asVoid,
  ),
  teardown: runMachineCommand(command, ["machine", "rm", "--force", machineName], "teardown", platform).pipe(
    Effect.asVoid,
  ),
});

export const ensureMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* machine.start;
      return;
    }
    if (status === "stopped") {
      yield* machine.start;
    }
  });

export const upgradeMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.upgrade;

export const stopMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.stop;

export const teardownMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.teardown;

export const ensureWindowsPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* machine.start;
      return;
    }
    if (status === "stopped") {
      yield* machine.start;
    }
  });

export const upgradeWindowsPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.upgrade;

export const stopWindowsPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.stop;

export const teardownWindowsPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<void, ProviderUnavailableError> => machine.teardown;

const parsePodmanVersion = (versionOutput: string): string => {
  const match = /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(versionOutput);
  return match?.[0] ?? versionOutput;
};

const infoPodmanVersion = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) {
    return undefined;
  }

  const version = "version" in info ? info.version : undefined;
  if (typeof version === "object" && version !== null && "Version" in version) {
    const podmanVersion = version.Version;
    return typeof podmanVersion === "string" ? podmanVersion : undefined;
  }

  return undefined;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalizeSha256 = (checksum: string): string => checksum.replace(/^sha256:/u, "");

const verifyRuntimeBundle = (bundle: RuntimeBundle) =>
  Effect.try({
    try: () => {
      const actual = sha256Hex(bundle.bytes);
      const expected = normalizeSha256(bundle.sha256);
      if (actual !== expected) {
        throw new ProviderBundleChecksumError("The Lando runtime bundle checksum did not match.", {
          expected,
          actual,
        });
      }
      return bundle;
    },
    catch: (cause) =>
      cause instanceof ProviderBundleChecksumError
        ? cause
        : new ProviderBundleChecksumError("Failed to verify the Lando runtime bundle checksum.", cause),
  });

const persistSetupState = (
  stateDir: string,
  state: {
    readonly podmanVersion: string;
    readonly runtimeBundleVersion?: string;
    readonly runtimeBundleSha256?: string;
    readonly runtimeBinDir?: string;
    readonly socketPath?: string;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const providerDir = `${stateDir.replace(/\/+$/u, "")}/provider-lando`;
      const statePath = providerStatePath(stateDir);

      await mkdir(providerDir, { recursive: true });
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      return statePath;
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "setup",
        message: "Unable to write provider-lando setup state.",
        remediation: `Check permissions for ${stateDir} and rerun \`lando setup\`.`,
        cause,
      }),
  });

const SETUP_PARENT_ID = "provider-setup";

const publishEvent = (
  eventService: EventPublisher | undefined,
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void> =>
  eventService === undefined ? Effect.void : eventService.publish(event).pipe(Effect.ignore);

interface SetupStep {
  readonly taskId: string;
  readonly label: string;
}

const buildSetupSteps = (
  platform: HostPlatform,
  hasBundle: boolean,
  hasStateDir: boolean,
): ReadonlyArray<SetupStep> => {
  const steps: SetupStep[] = [];
  if (hasBundle) steps.push({ taskId: "bundle", label: "Verify runtime bundle" });
  steps.push({ taskId: "podman", label: "Detect Podman" });
  if (platform === "darwin" || platform === "win32")
    steps.push({ taskId: "machine", label: "Ensure Podman machine" });
  steps.push({ taskId: "socket", label: "Probe Podman API" });
  if (hasStateDir) steps.push({ taskId: "state", label: "Persist setup state" });
  return steps;
};

interface StepCounter {
  succeeded: number;
}

const withStep = <A, E>(
  eventService: EventPublisher | undefined,
  step: SetupStep,
  counter: StepCounter,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const start = performance.now();
    yield* publishEvent(
      eventService,
      TaskStartEvent.make({
        _tag: "task.start",
        taskId: step.taskId,
        parentId: SETUP_PARENT_ID,
        label: step.label,
        timestamp: nowUtc(),
      }),
    );
    const result = yield* body.pipe(
      Effect.tapError((cause) =>
        publishEvent(
          eventService,
          TaskFailEvent.make({
            _tag: "task.fail",
            taskId: step.taskId,
            summary: step.label,
            ...(cause instanceof ProviderUnavailableError && cause.remediation !== undefined
              ? { remediation: cause.remediation }
              : {}),
            durationMs: Math.round(performance.now() - start),
            timestamp: nowUtc(),
          }),
        ),
      ),
    );
    yield* publishEvent(
      eventService,
      TaskCompleteEvent.make({
        _tag: "task.complete",
        taskId: step.taskId,
        summary: step.label,
        durationMs: Math.round(performance.now() - start),
        timestamp: nowUtc(),
      }),
    );
    counter.succeeded += 1;
    return result;
  });

export const setupProviderLando = (
  options: SetupOptions = {},
): Effect.Effect<SetupResult, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const platform = options.platform ?? currentHostPlatform();
    const hasBundle = options.runtimeBundleDownloader !== undefined;
    const hasStateDir = options.stateDir !== undefined;
    const steps = buildSetupSteps(platform, hasBundle, hasStateDir);
    const treeStart = performance.now();

    yield* publishEvent(
      options.eventService,
      TaskTreeStartEvent.make({
        _tag: "task.tree.start",
        parentId: SETUP_PARENT_ID,
        label: "Setting up Lando runtime",
        children: steps.map((step) => step.taskId),
        mode: "list",
        timestamp: nowUtc(),
      }),
    );

    const bundleStep = steps.find((step) => step.taskId === "bundle");
    const podmanStep = steps.find((step) => step.taskId === "podman");
    const machineStep = steps.find((step) => step.taskId === "machine");
    const socketStep = steps.find((step) => step.taskId === "socket");
    const stateStep = steps.find((step) => step.taskId === "state");

    if (podmanStep === undefined || socketStep === undefined) {
      return yield* Effect.die("internal: missing required setup steps");
    }

    const counter: StepCounter = { succeeded: 0 };

    const result = yield* Effect.gen(function* () {
      const runtimeBinDir = options.runtimeBinDir;
      const bundle =
        bundleStep === undefined || options.runtimeBundleDownloader === undefined
          ? undefined
          : yield* withStep(
              options.eventService,
              bundleStep,
              counter,
              options.runtimeBundleDownloader.download.pipe(
                Effect.flatMap(verifyRuntimeBundle),
                Effect.tap((verified) =>
                  runtimeBinDir === undefined
                    ? Effect.void
                    : installRuntimeBundle({
                        archiveBytes: verified.bytes,
                        version: verified.version,
                        runtimeBinDir,
                        platform,
                      }),
                ),
              ),
            );

      const podmanVersionOutput = yield* withStep(
        options.eventService,
        podmanStep,
        counter,
        (options.podmanCommand ?? makeSystemPodmanCommandRunner()).version,
      );

      if (platform === "darwin" && machineStep !== undefined) {
        yield* withStep(
          options.eventService,
          machineStep,
          counter,
          ensureMacOSPodmanMachine(
            options.podmanMachine ?? makeSystemPodmanMachineRunner(undefined, undefined, platform),
          ),
        );
      }

      if (platform === "win32" && machineStep !== undefined) {
        yield* withStep(
          options.eventService,
          machineStep,
          counter,
          ensureWindowsPodmanMachine(
            options.podmanMachine ?? makeSystemPodmanMachineRunner(undefined, undefined, platform),
          ),
        );
      }

      const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
      const api =
        options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));

      const info = yield* withStep(
        options.eventService,
        socketStep,
        counter,
        api === undefined
          ? Effect.fail(new PodmanSocketUnreachableError({ socketPath }))
          : api.info.pipe(Effect.mapError((cause) => new PodmanSocketUnreachableError(cause))),
      );

      const podmanVersion = infoPodmanVersion(info) ?? parsePodmanVersion(podmanVersionOutput);
      const statePath =
        stateStep === undefined || options.stateDir === undefined
          ? undefined
          : yield* withStep(
              options.eventService,
              stateStep,
              counter,
              persistSetupState(options.stateDir, {
                podmanVersion,
                ...(bundle === undefined
                  ? {}
                  : { runtimeBundleVersion: bundle.version, runtimeBundleSha256: bundle.sha256 }),
                ...(bundle !== undefined && runtimeBinDir !== undefined ? { runtimeBinDir } : {}),
                ...(socketPath === undefined ? {} : { socketPath }),
              }),
            );

      return {
        podmanVersion,
        ...(bundle === undefined ? {} : { runtimeBundleVersion: bundle.version }),
        ...(bundle !== undefined && runtimeBinDir !== undefined ? { runtimeBinDir } : {}),
        ...(statePath === undefined ? {} : { statePath }),
      } satisfies SetupResult;
    }).pipe(
      Effect.tapError(() =>
        publishEvent(
          options.eventService,
          TaskTreeCompleteEvent.make({
            _tag: "task.tree.complete",
            parentId: SETUP_PARENT_ID,
            summary: "Lando runtime setup failed",
            succeeded: counter.succeeded,
            failed: 1,
            durationMs: Math.round(performance.now() - treeStart),
            timestamp: nowUtc(),
          }),
        ),
      ),
    );

    yield* publishEvent(
      options.eventService,
      TaskTreeCompleteEvent.make({
        _tag: "task.tree.complete",
        parentId: SETUP_PARENT_ID,
        summary: "Lando runtime ready",
        succeeded: steps.length,
        failed: 0,
        durationMs: Math.round(performance.now() - treeStart),
        timestamp: nowUtc(),
      }),
    );

    return result;
  });

export { MINIMUM_PODMAN_VERSION };
