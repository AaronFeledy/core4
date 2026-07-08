import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { type Context, DateTime, Effect } from "effect";

import { managedRuntimePodmanArgv0 } from "@lando/core/managed-runtime-service";

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
import { IntelMacUnsupportedError, isIntelMacHost } from "./host-support.ts";
import { buildManagedMachineInitArgs, windowsHyperVPrepRemediation } from "./machine-trust.ts";

export { IntelMacUnsupportedError, isIntelMacHost } from "./host-support.ts";
import { type ArtifactDownload, ProviderBundleChecksumError } from "./runtime-bundle.ts";
import { writeManagedRuntimeContainersConf } from "./runtime-config.ts";
import { installRuntimeBundle } from "./runtime-extract.ts";
import { podmanVersionMeetsFloor } from "./version-floor.ts";

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

const PROVIDER_ID = "lando";
const MINIMUM_PODMAN_VERSION = "6.0.0";

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

export type PodmanVersionSource = "cli" | "api-info";

export class PodmanVersionUnsupportedError extends ProviderUnavailableError {
  constructor(observedVersion: string, source: PodmanVersionSource) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: `Podman version "${observedVersion}" (reported by ${
        source === "cli" ? "`podman --version`" : "the Podman API"
      }) does not satisfy the required minimum ${MINIMUM_PODMAN_VERSION}.`,
      details: { observedVersion, source, minimumVersion: MINIMUM_PODMAN_VERSION },
      remediation: `Install or select Podman >= ${MINIMUM_PODMAN_VERSION} and rerun \`lando setup\`.`,
    });
  }
}

const enforcePodmanVersionFloor = (
  observedVersion: string,
  source: PodmanVersionSource,
): Effect.Effect<void, PodmanVersionUnsupportedError> =>
  podmanVersionMeetsFloor(observedVersion, MINIMUM_PODMAN_VERSION)
    ? Effect.void
    : Effect.fail(new PodmanVersionUnsupportedError(observedVersion, source));

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
      remediation: windowsHyperVPrepRemediation(),
      cause,
    });
  }
}

export class WindowsMachineOsUnsupportedError extends ProviderUnavailableError {
  constructor() {
    super({
      providerId: PROVIDER_ID,
      operation: "upgrade",
      message: "Podman machine OS upgrade is not supported for WSL-backed Windows machines.",
      remediation:
        "Windows Podman machines run on WSL2, so their OS is managed by WSL; update it with `wsl --update` instead of `podman machine os upgrade`.",
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
  readonly arch?: string;
  readonly socketPath?: string;
  readonly skipSocketProbe?: boolean;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly readinessCheck?: Effect.Effect<void, ProviderUnavailableError>;
  readonly artifactDownload?: ArtifactDownload;
  readonly stateDir?: string;
  readonly runtimeBinDir?: string;
  readonly runtimeConfigDir?: string;
  readonly eventService?: EventPublisher;
  // Test-only seam (never set in production): overrides the bundled-tooling existence check.
  readonly _machineToolingExists?: (podmanBin: string) => boolean;
  // Test-only seam (never set in production): overrides construction of the bundled machine runner.
  readonly _machineRunnerFactory?: (
    command: string,
    machineName: string,
    platform: HostPlatform,
  ) => PodmanMachineRunner;
}

export interface SetupResult {
  readonly podmanVersion: string;
  readonly runtimeBundleVersion?: string;
  readonly runtimeBinDir?: string;
  readonly statePath?: string;
}

type RecordedMachineOwnership = { readonly name: "lando"; readonly createdByLando: boolean };

export const providerStatePath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/provider-lando/setup-state.json`;

const hasErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const readExistingMachineOwnership = (
  stateDir: string,
): Effect.Effect<RecordedMachineOwnership | undefined, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      let raw: string;
      try {
        raw = await readFile(providerStatePath(stateDir), "utf8");
      } catch (cause) {
        // No prior state file is a legitimate "nothing recorded yet" case, not a failure.
        if (hasErrorCode(cause, "ENOENT")) return undefined;
        throw cause;
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !("machine" in parsed)) return undefined;
      const machine = (parsed as { readonly machine: unknown }).machine;
      if (typeof machine !== "object" || machine === null) return undefined;
      const name = "name" in machine ? (machine as { readonly name: unknown }).name : undefined;
      const createdByLando =
        "createdByLando" in machine
          ? (machine as { readonly createdByLando: unknown }).createdByLando
          : undefined;
      if (name !== "lando" || typeof createdByLando !== "boolean") return undefined;
      const ownership: RecordedMachineOwnership = { name: "lando", createdByLando };
      return ownership;
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "setup",
        message: "Unable to read the existing provider-lando setup state.",
        remediation: `Check permissions for ${providerStatePath(stateDir)} and rerun \`lando setup\`.`,
        cause,
      }),
  });

const preserveRecordedMachineOwnership = (
  stateDir: string,
  current: RecordedMachineOwnership,
): Effect.Effect<RecordedMachineOwnership, ProviderUnavailableError> =>
  current.createdByLando
    ? Effect.succeed(current)
    : readExistingMachineOwnership(stateDir).pipe(
        Effect.map((existing) =>
          existing?.createdByLando === true ? { name: "lando", createdByLando: true } : current,
        ),
      );

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

// Subprocess shape for injectable spawn seams (tests capture argv without a real Podman binary).
interface MachineProcess {
  readonly stdout: ReadableStream<Uint8Array> | number | null | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined;
  readonly exited: Promise<number>;
}

export type MachineSpawn = (argv: ReadonlyArray<string>) => MachineProcess;

const defaultMachineSpawn: MachineSpawn = (argv) => Bun.spawn([...argv], { stderr: "pipe", stdout: "pipe" });

const readProcess = async (proc: MachineProcess) => {
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
  spawn: MachineSpawn,
  command: string,
  args: ReadonlyArray<string>,
  operation: string,
  platform: HostPlatform,
) =>
  Effect.tryPromise({
    try: async () => {
      const result = await readProcess(spawn([command, ...args]));
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
  spawn: MachineSpawn = defaultMachineSpawn,
): PodmanMachineRunner => ({
  inspect: runMachineCommand(spawn, command, ["machine", "inspect", machineName], "inspect", platform).pipe(
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
  create: runMachineCommand(
    spawn,
    command,
    buildManagedMachineInitArgs(machineName),
    "create",
    platform,
  ).pipe(Effect.asVoid),
  start: runMachineCommand(
    spawn,
    command,
    ["machine", "start", "--update-connection=false", machineName],
    "start",
    platform,
  ).pipe(Effect.asVoid),
  stop: runMachineCommand(spawn, command, ["machine", "stop", machineName], "stop", platform).pipe(
    Effect.asVoid,
  ),
  upgrade:
    platform === "win32"
      ? Effect.fail(new WindowsMachineOsUnsupportedError())
      : runMachineCommand(
          spawn,
          command,
          ["machine", "os", "upgrade", machineName],
          "upgrade",
          platform,
        ).pipe(Effect.asVoid),
  teardown: runMachineCommand(
    spawn,
    command,
    ["machine", "rm", "--force", machineName],
    "teardown",
    platform,
  ).pipe(Effect.asVoid),
});

const MANAGED_MACHINE_NAME = "lando";

const missingBundledMachineToolingError = (
  platform: HostPlatform,
  podmanBin?: string,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: `The installed Lando runtime bundle does not provide Podman tooling for ${platform}.`,
    remediation:
      "Reinstall the managed runtime with `lando setup`; the bundled Podman tooling for this platform was not found in the runtime bundle.",
    ...(podmanBin === undefined ? {} : { details: { platform, podmanBin } }),
  });

// Require bundled Podman on disk before spawn so failures use missingBundledMachineToolingError, not PodmanNotInstalledError.
const resolveSetupPodmanCommandRunner = (
  platform: HostPlatform,
  runtimeBinDir: string | undefined,
  toolingExists: (podmanBin: string) => boolean,
): Effect.Effect<PodmanCommandRunner, ProviderUnavailableError> => {
  if (runtimeBinDir === undefined) {
    return Effect.succeed(makeSystemPodmanCommandRunner());
  }

  const podmanBin = managedRuntimePodmanArgv0(runtimeBinDir, platform);
  if (!toolingExists(podmanBin)) {
    return Effect.fail(missingBundledMachineToolingError(platform, podmanBin));
  }

  return Effect.succeed(makeSystemPodmanCommandRunner(podmanBin));
};

const resolveSetupMachineRunner = (
  platform: "darwin" | "win32",
  options: SetupOptions,
): Effect.Effect<PodmanMachineRunner, ProviderUnavailableError> => {
  if (options.podmanMachine !== undefined) return Effect.succeed(options.podmanMachine);

  const runtimeBinDir = options.runtimeBinDir;
  if (runtimeBinDir === undefined) return Effect.fail(missingBundledMachineToolingError(platform));

  const podmanBin = managedRuntimePodmanArgv0(runtimeBinDir, platform);
  const toolingExists = (options._machineToolingExists ?? existsSync)(podmanBin);
  if (!toolingExists) return Effect.fail(missingBundledMachineToolingError(platform, podmanBin));

  const factory = options._machineRunnerFactory ?? makeSystemPodmanMachineRunner;
  return Effect.succeed(factory(podmanBin, MANAGED_MACHINE_NAME, platform));
};

export const ensureMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
): Effect.Effect<{ readonly createdByLando: boolean }, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* machine.start;
      return { createdByLando: true };
    }
    if (status === "stopped") {
      yield* machine.start;
    }
    return { createdByLando: false };
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
): Effect.Effect<{ readonly createdByLando: boolean }, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* machine.start;
      return { createdByLando: true };
    }
    if (status === "stopped") {
      yield* machine.start;
    }
    return { createdByLando: false };
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
    readonly machine?: { readonly name: "lando"; readonly createdByLando: boolean };
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
  probesSocket: boolean,
): ReadonlyArray<SetupStep> => {
  const steps: SetupStep[] = [];
  if (hasBundle) steps.push({ taskId: "bundle", label: "Verify runtime bundle" });
  steps.push({ taskId: "podman", label: "Detect Podman" });
  if (platform === "darwin" || platform === "win32")
    steps.push({ taskId: "machine", label: "Ensure Podman machine" });
  if (probesSocket) steps.push({ taskId: "socket", label: "Probe Podman API" });
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
    const arch = options.arch ?? (options.platform === undefined ? process.arch : undefined);
    if (isIntelMacHost(platform, arch)) {
      return yield* Effect.fail(new IntelMacUnsupportedError(arch ?? "x64"));
    }
    const hasBundle = options.runtimeBundleDownloader !== undefined;
    const hasStateDir = options.stateDir !== undefined;
    const probesSocket = options.skipSocketProbe !== true;
    const steps = buildSetupSteps(platform, hasBundle, hasStateDir, probesSocket);
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

    if (podmanStep === undefined || (probesSocket && socketStep === undefined)) {
      return yield* Effect.die("internal: missing required setup steps");
    }

    const counter: StepCounter = { succeeded: 0 };

    const result = yield* Effect.gen(function* () {
      const runtimeBinDir = options.runtimeBinDir;
      const runtimeConfigDir = options.runtimeConfigDir;
      let machineOwnership: RecordedMachineOwnership | undefined;
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

      if (runtimeBinDir !== undefined && runtimeConfigDir !== undefined) {
        yield* writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir });
      }

      const podmanVersionOutput = yield* withStep(
        options.eventService,
        podmanStep,
        counter,
        (options.podmanCommand !== undefined
          ? options.podmanCommand.version
          : resolveSetupPodmanCommandRunner(
              platform,
              options.runtimeBinDir,
              options._machineToolingExists ?? existsSync,
            ).pipe(Effect.flatMap((runner) => runner.version))
        ).pipe(Effect.tap((output) => enforcePodmanVersionFloor(parsePodmanVersion(output), "cli"))),
      );

      if (platform === "darwin" && machineStep !== undefined) {
        const ensured = yield* withStep(
          options.eventService,
          machineStep,
          counter,
          resolveSetupMachineRunner("darwin", options).pipe(Effect.flatMap(ensureMacOSPodmanMachine)),
        );
        machineOwnership = { name: "lando", createdByLando: ensured.createdByLando };
      }

      if (platform === "win32" && machineStep !== undefined) {
        const ensured = yield* withStep(
          options.eventService,
          machineStep,
          counter,
          resolveSetupMachineRunner("win32", options).pipe(Effect.flatMap(ensureWindowsPodmanMachine)),
        );
        machineOwnership = { name: "lando", createdByLando: ensured.createdByLando };
      }

      const socketPath = options.socketPath;
      const api =
        options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));

      let info: unknown;
      if (!options.skipSocketProbe && socketStep !== undefined) {
        info = yield* withStep(
          options.eventService,
          socketStep,
          counter,
          api === undefined
            ? Effect.fail(new PodmanSocketUnreachableError({ socketPath }))
            : api.info.pipe(
                Effect.mapError((cause) => new PodmanSocketUnreachableError(cause)),
                Effect.tap((value) => {
                  const apiVersion = infoPodmanVersion(value);
                  return apiVersion === undefined
                    ? Effect.void
                    : enforcePodmanVersionFloor(apiVersion, "api-info");
                }),
              ),
        );
      }

      const podmanVersion = infoPodmanVersion(info) ?? parsePodmanVersion(podmanVersionOutput);
      const readinessCheck = options.readinessCheck ?? Effect.void;
      yield* readinessCheck;
      const recordedMachineOwnership =
        machineOwnership === undefined || options.stateDir === undefined
          ? machineOwnership
          : yield* preserveRecordedMachineOwnership(options.stateDir, machineOwnership);
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
                ...(recordedMachineOwnership === undefined ? {} : { machine: recordedMachineOwnership }),
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
