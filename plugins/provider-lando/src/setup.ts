import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";

import { type PodmanApiClient, makePodmanApiClient } from "./capabilities.ts";

const PROVIDER_ID = "lando";
const MINIMUM_PODMAN_VERSION = "4.9.0";

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

export class RuntimeBundleVerificationError extends ProviderUnavailableError {
  constructor(message: string, cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message,
      remediation:
        "The Lando runtime bundle did not match its pinned checksum. Retry `lando setup`; if it fails again, report the release artifact and checksum.",
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
  readonly stateDir?: string;
}

export interface SetupResult {
  readonly podmanVersion: string;
  readonly runtimeBundleVersion?: string;
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

const machineFailure = (operation: string, cause: unknown): ProviderUnavailableError => {
  const output = typeof cause === "object" && cause !== null && "stderr" in cause ? cause.stderr : cause;
  if (typeof output === "string" && /virtualization|vfkit|hypervisor|qemu|helper/i.test(output)) {
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

const runMachineCommand = (command: string, args: ReadonlyArray<string>, operation: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await readProcess(Bun.spawn([command, ...args], { stderr: "pipe", stdout: "pipe" }));
      if (result.exitCode !== 0) {
        throw result;
      }
      return result.stdout;
    },
    catch: (cause) => machineFailure(operation, cause),
  });

export const makeSystemPodmanMachineRunner = (
  command = "podman",
  machineName = "lando",
): PodmanMachineRunner => ({
  inspect: runMachineCommand(command, ["machine", "inspect", machineName], "inspect").pipe(
    // `Effect.map` does not catch synchronous throws, so a malformed `podman machine inspect`
    // payload would become an Effect defect instead of a typed `ProviderUnavailableError`.
    // Channel parse failures through `Effect.try` so callers always see the tagged error.
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
    // Exit code 125 from `podman machine inspect` is "no such machine" only when stderr
    // confirms the absence; other 125 failures (prerequisite errors, broken state) must
    // surface so we don't silently treat them as a missing machine.
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
  create: runMachineCommand(command, ["machine", "init", machineName], "create").pipe(Effect.asVoid),
  start: runMachineCommand(command, ["machine", "start", machineName], "start").pipe(Effect.asVoid),
  stop: runMachineCommand(command, ["machine", "stop", machineName], "stop").pipe(Effect.asVoid),
  upgrade: runMachineCommand(command, ["machine", "os", "apply", machineName], "upgrade").pipe(Effect.asVoid),
  teardown: runMachineCommand(command, ["machine", "rm", "--force", machineName], "teardown").pipe(
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
        throw new RuntimeBundleVerificationError("The Lando runtime bundle checksum did not match.", {
          expected,
          actual,
        });
      }
      return bundle;
    },
    catch: (cause) =>
      cause instanceof RuntimeBundleVerificationError
        ? cause
        : new RuntimeBundleVerificationError("Failed to verify the Lando runtime bundle checksum.", cause),
  });

const persistSetupState = (
  stateDir: string,
  state: {
    readonly podmanVersion: string;
    readonly runtimeBundleVersion?: string;
    readonly runtimeBundleSha256?: string;
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

export const setupProviderLando = (
  options: SetupOptions = {},
): Effect.Effect<SetupResult, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const platform =
      options.platform ??
      (process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32");
    const bundle =
      options.runtimeBundleDownloader === undefined
        ? undefined
        : yield* options.runtimeBundleDownloader.download.pipe(Effect.flatMap(verifyRuntimeBundle));
    const podmanVersionOutput = yield* (options.podmanCommand ?? makeSystemPodmanCommandRunner()).version;
    if (platform === "darwin") {
      yield* ensureMacOSPodmanMachine(options.podmanMachine ?? makeSystemPodmanMachineRunner());
    }
    const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
    const api = options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));

    if (api === undefined) {
      return yield* Effect.fail(new PodmanSocketUnreachableError({ socketPath }));
    }

    // Provider setup validates the API socket after any pinned runtime bundle has been verified.
    const info = yield* api.info.pipe(Effect.mapError((cause) => new PodmanSocketUnreachableError(cause)));
    const podmanVersion = infoPodmanVersion(info) ?? parsePodmanVersion(podmanVersionOutput);
    const statePath =
      options.stateDir === undefined
        ? undefined
        : yield* persistSetupState(options.stateDir, {
            podmanVersion,
            ...(bundle === undefined
              ? {}
              : { runtimeBundleVersion: bundle.version, runtimeBundleSha256: bundle.sha256 }),
          });

    return {
      podmanVersion,
      ...(bundle === undefined ? {} : { runtimeBundleVersion: bundle.version }),
      ...(statePath === undefined ? {} : { statePath }),
    };
  });

export { MINIMUM_PODMAN_VERSION };
