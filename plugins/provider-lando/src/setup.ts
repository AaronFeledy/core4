import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { Cause, DateTime, Effect, Exit } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { makePodmanApiClient as makeRuntimePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import {
  MINIMUM_PODMAN_VERSION,
  podmanVersionMeetsFloor,
} from "@lando/container-runtime/podman/version-floor";
import { managedRuntimePodmanArgv0 } from "./managed-runtime-service.ts";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type HostPlatform,
  type HostPlatformFamily,
  type PortNumber,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { type ProgressEmitter, type TaskTreeController, makeTaskTree } from "@lando/sdk/task-progress";

import { rejectIntelMacHost } from "./host-support.ts";
import {
  buildManagedMachineInitArgs,
  buildManagedMachineTrustSyncArgs,
  resolveMachineTrustImport,
  windowsHyperVPrepRemediation,
} from "./machine-trust.ts";

export {
  INTEL_MAC_UNSUPPORTED_REMEDIATION,
  IntelMacUnsupportedError,
  isIntelMacHost,
  rejectIntelMacHost,
} from "./host-support.ts";
import { ensureManagedNft } from "./nft-provision.ts";
import { LANDO_CTX } from "./provider-context.ts";
import { type ArtifactDownload, ProviderBundleChecksumError } from "./runtime-bundle.ts";
import { writeManagedRuntimeContainersConf } from "./runtime-config.ts";
import { installRuntimeBundle } from "./runtime-extract.ts";

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

const PROVIDER_ID = "lando";
const WINDOWS_MACHINE_HELPERS = ["gvproxy.exe", "win-sshproxy.exe"] as const;

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

import { windowsPublishClaims } from "./windows-publish-claims.ts";

export interface PodmanCommandRunner {
  readonly version: Effect.Effect<string, ProviderUnavailableError>;
}

export type PodmanMachineStatus = "missing" | "stopped" | "running";

export interface PodmanMachineRunner {
  readonly inspect: Effect.Effect<PodmanMachineStatus, ProviderUnavailableError>;
  readonly createdAt?: Effect.Effect<string, ProviderUnavailableError>;
  readonly create: Effect.Effect<void, ProviderUnavailableError>;
  readonly syncTrust?: Effect.Effect<void, ProviderUnavailableError>;
  readonly activateApiSocket?: Effect.Effect<void, ProviderUnavailableError>;
  readonly occupiedPublishPorts?: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<number>, ProviderUnavailableError>;
  readonly matchingPublishPorts?: (
    ports: ReadonlyArray<number>,
    addresses: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<number>, ProviderUnavailableError>;
  readonly publishedRuleSnapshot?: Effect.Effect<
    { readonly kernelBootId: string; readonly nftJson: string } | undefined,
    ProviderUnavailableError
  >;
  readonly deletePublishedRule?: (
    chain: string,
    handle: number,
  ) => Effect.Effect<void, ProviderUnavailableError>;
  readonly hostPortOwners?: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyMap<number, "free" | "wslrelay" | "foreign">, ProviderUnavailableError>;
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
  readonly platform: HostPlatform;
  readonly arch?: string;
  readonly socketPath?: string;
  readonly skipSocketProbe?: boolean;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly readinessCheck?: Effect.Effect<void, ProviderUnavailableError>;
  readonly managedRuntimeSetup?: (progress: RuntimeSetupProgress) => Effect.Effect<void, ProviderError>;
  readonly smoke?: boolean;
  readonly artifactDownload?: ArtifactDownload;
  readonly nftArtifactDownload?: ArtifactDownload;
  readonly nftCacheDir?: string;
  readonly stateDir?: string;
  readonly runtimeBinDir?: string;
  readonly runtimeConfigDir?: string;
  readonly eventService?: ProgressEmitter;
  // Test-only seam (never set in production): overrides the bundled-tooling existence check.
  readonly _machineToolingExists?: (podmanBin: string) => boolean;
  // Test-only seam (never set in production): overrides construction of the bundled machine runner.
  readonly _machineRunnerFactory?: (
    command: string,
    machineName: string,
    platform: HostPlatform,
  ) => PodmanMachineRunner;
}

export type RuntimeSetupPhase = "prerequisites" | "launch" | "readiness" | "smoke";

export interface RuntimeSetupProgress {
  readonly runtimeBundleVersion?: string;
  readonly run: <A, E>(phase: RuntimeSetupPhase, body: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

export interface SetupResult {
  readonly podmanVersion: string;
  readonly runtimeBundleVersion?: string;
  readonly runtimeBinDir?: string;
  readonly statePath?: string;
}

type RecordedMachineOwnership = {
  readonly name: "lando";
  readonly createdByLando: boolean;
  readonly createdAt?: string;
};

export const providerStatePath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/provider-lando/setup-state.json`;

const hasErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const readExistingMachineOwnership = (
  stateDir: string,
  eventService?: ProgressEmitter,
): Effect.Effect<RecordedMachineOwnership | undefined, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(providerStatePath(stateDir), "utf8"),
      catch: (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "setup",
          message: "Unable to read the existing provider-lando setup state.",
          remediation: `Check permissions for ${providerStatePath(stateDir)} and rerun \`lando setup\`.`,
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        (cause) => hasErrorCode(cause.cause, "ENOENT"),
        () => Effect.succeed(undefined),
      ),
    );
    if (raw === undefined) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) return yield* Effect.die(cause);
      yield* publishWarn(
        eventService,
        MessageWarnEvent.make({
          _tag: "message.warn",
          body: `Ignoring corrupt provider setup state at ${providerStatePath(stateDir)}.`,
          timestamp: nowUtc(),
        }),
      );
      return undefined;
    }

    if (typeof parsed !== "object" || parsed === null || !("machine" in parsed)) return undefined;
    const machine = (parsed as { readonly machine: unknown }).machine;
    if (typeof machine !== "object" || machine === null) return undefined;
    const name = "name" in machine ? (machine as { readonly name: unknown }).name : undefined;
    const createdByLando =
      "createdByLando" in machine
        ? (machine as { readonly createdByLando: unknown }).createdByLando
        : undefined;
    if (name !== "lando" || typeof createdByLando !== "boolean") return undefined;
    const createdAt = "createdAt" in machine ? machine.createdAt : undefined;
    if (createdAt !== undefined && (typeof createdAt !== "string" || createdAt.length === 0))
      return undefined;
    const ownership: RecordedMachineOwnership = {
      name: "lando",
      createdByLando,
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    return ownership;
  });

const verifyRecordedMachineOwnership = (
  recorded: RecordedMachineOwnership | undefined,
  machine: PodmanMachineRunner,
): Effect.Effect<RecordedMachineOwnership | undefined, ProviderUnavailableError> =>
  Effect.gen(function* () {
    if (recorded?.createdByLando !== true || recorded.createdAt === undefined) return recorded;
    if ((yield* machine.inspect) === "missing") return { name: "lando", createdByLando: false };
    if (machine.createdAt === undefined) return { name: "lando", createdByLando: false };
    const actual = yield* machine.createdAt;
    return actual === recorded.createdAt ? recorded : { name: "lando" as const, createdByLando: false };
  });

const createdMachineOwnership = (
  machine: PodmanMachineRunner,
): Effect.Effect<RecordedMachineOwnership, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const createdAt = machine.createdAt === undefined ? undefined : yield* machine.createdAt;
    return {
      name: "lando" as const,
      createdByLando: true,
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  });

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

const WINDOWS_MACHINE_PREREQUISITE_FAILURE =
  /(?:hcs\/(?:error_not_supported|hcs_e_service_not_available)|(?:(?:virtualization|hyper-v|wsl2?|wslapi|virtual machine platform|hypervisor)(?:\s+(?:support|features?|prerequisites?))?[\s:=-]+(?:(?:is|are)[\s:=-]+)?(?:unavailable|disabled|missing|required|not[ -](?:enabled|installed|available|supported))|(?:unavailable|disabled|missing|required|not[ -](?:enabled|installed|available|supported))[\s:=-]+(?:virtualization|hyper-v|wsl2?|wslapi|virtual machine platform|hypervisor)))/iu;
const WINDOWS_MACHINE_CREATE_PREREQUISITE_FAILURE =
  /(?:wsl\s+import\s+of\s+guest\s+os\s+failed|wsl\s*2\s+requires\s+an?\s+update\s+to\s+its\s+kernel(?:\s+component)?)/iu;

const machineFailure = (
  operation: string,
  cause: unknown,
  platform: HostPlatform,
): ProviderUnavailableError => {
  const family = hostPlatformFamily(platform);
  const output =
    typeof cause === "object" && cause !== null
      ? ["stdout" in cause ? cause.stdout : undefined, "stderr" in cause ? cause.stderr : undefined]
          .filter((value): value is string => typeof value === "string")
          .join("\n")
      : cause;
  const normalizedOutput = typeof output === "string" ? output.replaceAll("\0", "") : output;
  const diagnostics = typeof normalizedOutput === "string" ? normalizedOutput.trim() : "";
  const missingHelper =
    family === "win32" && typeof normalizedOutput === "string"
      ? WINDOWS_MACHINE_HELPERS.find(
          (helper) =>
            normalizedOutput.toLowerCase().includes(helper) &&
            /not found|could not find|missing|no such/iu.test(normalizedOutput),
        )
      : undefined;
  if (missingHelper !== undefined) {
    return new ProviderUnavailableError({
      providerId: PROVIDER_ID,
      operation,
      message: `Podman machine ${operation} failed because required helper ${missingHelper} was not found.`,
      remediation:
        "Rerun `lando setup --provider=lando` to reinstall the managed Windows runtime bundle, then retry.",
      details: { helper: missingHelper },
    });
  }
  if (
    family === "win32" &&
    typeof normalizedOutput === "string" &&
    (WINDOWS_MACHINE_PREREQUISITE_FAILURE.test(normalizedOutput) ||
      (operation === "create" && WINDOWS_MACHINE_CREATE_PREREQUISITE_FAILURE.test(normalizedOutput)))
  ) {
    return new WindowsMachinePrerequisiteError(cause);
  }
  if (
    family === "darwin" &&
    typeof normalizedOutput === "string" &&
    /virtualization|vfkit|hypervisor|qemu|helper/i.test(normalizedOutput)
  ) {
    return new PodmanMachinePrerequisiteError(cause);
  }

  return new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message:
      diagnostics.length === 0
        ? `Podman machine ${operation} failed.`
        : `Podman machine ${operation} failed.\nPodman output:\n${diagnostics}`,
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

// WSL launches the guest's systemd in a separate PID and mount namespace. A
// direct `wsl.exe --exec systemctl` cannot reach its bus, and `podman machine
// ssh` inherits unrelated host SSH configuration. Select exactly one root
// system manager inside this machine, then start its rootful API socket.
const WINDOWS_WSL_PODMAN_SOCKET_ACTIVATION_SCRIPT = `
outer_ns=$(readlink /proc/1/ns/pid)
[ -n "$outer_ns" ] || { echo 'Host PID namespace not found' >&2; exit 1; }
systemd_pid=
for proc in /proc/[0-9]*; do
  [ "$(cat "$proc/comm" 2>/dev/null)" = systemd ] || continue
  [ "$(stat -c %u "$proc" 2>/dev/null)" = 0 ] || continue
  guest_ns=$(readlink "$proc/ns/pid" 2>/dev/null)
  [ -n "$guest_ns" ] && [ "$guest_ns" != "$outer_ns" ] || continue
  [ "$(awk '/^NSpid:/ { print $NF }' "$proc/status" 2>/dev/null)" = 1 ] || continue
  [ -z "$systemd_pid" ] || { echo 'Multiple guest systemd processes' >&2; exit 1; }
  systemd_pid=\${proc##*/}
done
[ -n "$systemd_pid" ] || { echo 'Guest systemd process not found' >&2; exit 1; }
exec nsenter --target "$systemd_pid" --mount --pid -- systemctl enable --now podman.socket
`;

const podmanMachineJson = (stdout: string, operation: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(stdout),
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation,
        message: "Podman returned invalid machine metadata.",
        remediation:
          "Check `podman machine info` and `podman machine inspect lando`, then rerun `lando setup`.",
        cause,
      }),
  });

const isWslMachineHost = (info: unknown): boolean => {
  if (typeof info !== "object" || info === null || !("Host" in info)) return false;
  const host = info.Host;
  return typeof host === "object" && host !== null && "VMType" in host && host.VMType === "wsl";
};

const isRootfulMachine = (info: unknown): boolean => {
  const machine = Array.isArray(info) ? info[0] : info;
  return typeof machine === "object" && machine !== null && "Rootful" in machine && machine.Rootful === true;
};
export const makeSystemPodmanMachineRunner = (
  command: string,
  machineName: string,
  platform: HostPlatform,
  spawn: MachineSpawn = defaultMachineSpawn,
): PodmanMachineRunner => {
  const family = hostPlatformFamily(platform);
  const activateApiSocket = Effect.gen(function* () {
    const info = yield* runMachineCommand(
      spawn,
      command,
      ["machine", "info", "--format", "json"],
      "activateApiSocket",
      platform,
    ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "activateApiSocket")));
    if (!isWslMachineHost(info)) return;

    const inspected = yield* runMachineCommand(
      spawn,
      command,
      ["machine", "inspect", machineName],
      "activateApiSocket",
      platform,
    ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "activateApiSocket")));
    if (!isRootfulMachine(inspected)) return;

    yield* runMachineCommand(
      spawn,
      "wsl.exe",
      [
        "--distribution",
        `podman-${machineName}`,
        "--user",
        "root",
        "--exec",
        "sh",
        "-c",
        WINDOWS_WSL_PODMAN_SOCKET_ACTIVATION_SCRIPT,
      ],
      "activateApiSocket",
      platform,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "setup",
            message: "Could not activate the Lando Podman machine API socket.",
            remediation:
              "Check that the Lando-owned WSL Podman machine can start its systemd podman.socket, then rerun `lando setup`.",
            cause,
          }),
      ),
    );
  });

  const readPublishClaims = () =>
    runMachineCommand(
      spawn,
      "wsl.exe",
      ["--distribution", `podman-${machineName}`, "--user", "root", "--exec", "nft", "-j", "list", "ruleset"],
      "occupiedPublishPorts",
      platform,
    ).pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => windowsPublishClaims(raw),
          catch: (cause) =>
            new ProviderUnavailableError({
              providerId: PROVIDER_ID,
              operation: "occupiedPublishPorts",
              message: "Could not interpret the Lando Podman machine's published-port rules.",
              remediation: "Check guest nftables rules and retry. Lando will not reuse ambiguous ports.",
              cause,
            }),
        }),
      ),
    );

  const occupiedPublishPorts = (ports: ReadonlyArray<PortNumber>) =>
    Effect.gen(function* () {
      if (ports.length === 0) return [];
      const info = yield* runMachineCommand(
        spawn,
        command,
        ["machine", "info", "--format", "json"],
        "occupiedPublishPorts",
        platform,
      ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "occupiedPublishPorts")));
      if (!isWslMachineHost(info)) return [];
      const inspected = yield* runMachineCommand(
        spawn,
        command,
        ["machine", "inspect", machineName],
        "occupiedPublishPorts",
        platform,
      ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "occupiedPublishPorts")));
      const machine = Array.isArray(inspected) ? inspected[0] : inspected;
      const state =
        typeof machine === "object" && machine !== null && "State" in machine ? machine.State : undefined;
      if (typeof state !== "string" || !/running/i.test(state)) return [];
      const sockets = yield* runMachineCommand(
        spawn,
        "wsl.exe",
        ["--distribution", `podman-${machineName}`, "--user", "root", "--exec", "ss", "-H", "-ltn"],
        "occupiedPublishPorts",
        platform,
      );
      const claims = yield* readPublishClaims();
      const candidates = new Set(ports);
      const occupied = new Set<PortNumber>();
      for (const line of sockets.split(/\r?\n/u)) {
        const address = line.trim().split(/\s+/u)[3];
        const port = Number(address?.slice((address?.lastIndexOf(":") ?? -1) + 1));
        if (Number.isInteger(port) && candidates.has(port)) occupied.add(port);
      }
      for (const port of claims.keys()) if (candidates.has(port)) occupied.add(port);
      return ports.filter((port) => occupied.has(port));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "occupiedPublishPorts",
            message: "Could not inspect published TCP ports in the Lando-owned Podman machine.",
            remediation: "Check guest `ss` and `nft` commands, then retry.",
            cause,
          }),
      ),
    );

  const matchingPublishPorts = (ports: ReadonlyArray<PortNumber>, addresses: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ports.length === 0 || addresses.length === 0) return [];
      const info = yield* runMachineCommand(
        spawn,
        command,
        ["machine", "info", "--format", "json"],
        "matchingPublishPorts",
        platform,
      ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "matchingPublishPorts")));
      if (!isWslMachineHost(info)) return [];
      const claims = yield* readPublishClaims();
      const owned = new Set(addresses);
      return ports.filter((port) => {
        const targets = claims.get(port);
        return targets !== undefined && targets.size > 0 && [...targets].every((target) => owned.has(target));
      });
    });
  const hostPortOwners = (ports: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
        return yield* Effect.fail(
          machineFailure("hostPortOwners", new Error("Invalid host port."), platform),
        );
      }
      if (ports.length === 0) return new Map<number, "free" | "wslrelay" | "foreign">();
      const script = `$ErrorActionPreference='Stop'; $ports=@(${ports.join(",")});
$expected=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WSL/wslrelay.exe'));
$allListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop |
  Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') });
$rows=@(foreach($port in $ports) {
  $listeners=@($allListeners | Where-Object { $_.LocalPort -eq $port });
  $owner='free';
  if($listeners.Count -gt 0) {
    $owner='wslrelay';
    foreach($listener in $listeners) {
      $proc=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $listener.OwningProcess);
      if($null -eq $proc -or [string]::IsNullOrWhiteSpace($proc.ExecutablePath) -or
         !([string]::Equals([IO.Path]::GetFullPath($proc.ExecutablePath),$expected,
          [StringComparison]::OrdinalIgnoreCase))) { $owner='foreign'; break }
    }
  }
  @{ port=$port; owner=$owner }
});
ConvertTo-Json -InputObject $rows -Compress`;
      const raw = yield* runMachineCommand(
        spawn,
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        "hostPortOwners",
        platform,
      );
      return yield* Effect.try({
        try: () => {
          const rows: unknown = JSON.parse(raw);
          if (!Array.isArray(rows) || rows.length !== ports.length)
            throw new Error("Incomplete host port probe.");
          const owners = new Map<number, "free" | "wslrelay" | "foreign">();
          for (const row of rows) {
            if (
              typeof row !== "object" ||
              row === null ||
              !("port" in row) ||
              !("owner" in row) ||
              typeof row.port !== "number" ||
              !ports.includes(row.port) ||
              (row.owner !== "free" && row.owner !== "wslrelay" && row.owner !== "foreign") ||
              owners.has(row.port)
            )
              throw new Error("Invalid host port owner result.");
            owners.set(row.port, row.owner);
          }
          return owners;
        },
        catch: (cause) => machineFailure("hostPortOwners", cause, platform),
      });
    });
  const publishedRuleSnapshot = Effect.gen(function* () {
    const info = yield* runMachineCommand(
      spawn,
      command,
      ["machine", "info", "--format", "json"],
      "publishedRuleSnapshot",
      platform,
    ).pipe(Effect.flatMap((stdout) => podmanMachineJson(stdout, "publishedRuleSnapshot")));
    if (!isWslMachineHost(info)) return undefined;
    const [kernelBootId, nftJson] = yield* Effect.all([
      runMachineCommand(
        spawn,
        "wsl.exe",
        [
          "--distribution",
          `podman-${machineName}`,
          "--user",
          "root",
          "--exec",
          "cat",
          "/proc/sys/kernel/random/boot_id",
        ],
        "publishedRuleSnapshot",
        platform,
      ),
      runMachineCommand(
        spawn,
        "wsl.exe",
        [
          "--distribution",
          `podman-${machineName}`,
          "--user",
          "root",
          "--exec",
          "nft",
          "-j",
          "list",
          "ruleset",
        ],
        "publishedRuleSnapshot",
        platform,
      ),
    ]);
    const bootId = kernelBootId.trim();
    if (!/^[a-f0-9-]{36}$/iu.test(bootId)) {
      return yield* Effect.fail(
        machineFailure(
          "publishedRuleSnapshot",
          new Error("Guest kernel boot identity is invalid."),
          platform,
        ),
      );
    }
    return { kernelBootId: bootId, nftJson };
  });

  const deletePublishedRule = (chain: string, handle: number) =>
    Effect.gen(function* () {
      if (
        !/^nv_[a-f0-9]{8}_[a-zA-Z0-9_-]+_dnat$/u.test(chain) ||
        !Number.isSafeInteger(handle) ||
        handle < 1
      ) {
        return yield* Effect.fail(
          machineFailure("deletePublishedRule", new Error("Owned nft rule identity is invalid."), platform),
        );
      }
      yield* runMachineCommand(
        spawn,
        "wsl.exe",
        [
          "--distribution",
          `podman-${machineName}`,
          "--user",
          "root",
          "--exec",
          "nft",
          "delete",
          "rule",
          "inet",
          "netavark",
          chain,
          "handle",
          String(handle),
        ],
        "deletePublishedRule",
        platform,
      );
    });
  return {
    ...(family === "win32"
      ? {
          activateApiSocket,
          occupiedPublishPorts,
          matchingPublishPorts,
          publishedRuleSnapshot,
          deletePublishedRule,
          hostPortOwners,
        }
      : {}),
    createdAt: runMachineCommand(
      spawn,
      command,
      ["machine", "inspect", machineName],
      "createdAt",
      platform,
    ).pipe(
      Effect.flatMap((stdout) => podmanMachineJson(stdout, "createdAt")),
      Effect.flatMap((value) => {
        const machine = Array.isArray(value) ? value[0] : value;
        const created =
          typeof machine === "object" && machine !== null && "Created" in machine
            ? machine.Created
            : undefined;
        return typeof created === "string" && created.length > 0
          ? Effect.succeed(created)
          : Effect.fail(
              machineFailure(
                "createdAt",
                new Error("Podman machine creation identity is missing."),
                platform,
              ),
            );
      }),
    ),
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
      buildManagedMachineInitArgs(machineName, platform),
      "create",
      platform,
    ).pipe(Effect.asVoid),
    syncTrust: runMachineCommand(
      spawn,
      command,
      buildManagedMachineTrustSyncArgs(machineName),
      "syncTrust",
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
      family === "win32"
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
  };
};

export const MANAGED_MACHINE_NAME = "lando";

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

const bundledPodmanLaunchError = (
  platform: HostPlatform,
  podmanBin: string,
  cause: PodmanNotInstalledError,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: `The managed runtime bundle Podman executable at ${podmanBin} failed to launch.`,
    remediation:
      "Reinstall the managed runtime with `lando setup`; if the bundled executable still fails, report the managed runtime bundle failure.",
    details: { platform, podmanBin },
    cause: cause.cause ?? cause,
  });

const missingBundledMachineHelperError = (helper: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: `The installed Lando runtime bundle is missing required Windows machine helper ${helper}.`,
    remediation:
      "Rerun `lando setup --provider=lando` to reinstall the managed Windows runtime bundle, then retry.",
    details: { helper },
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

  const runner = makeSystemPodmanCommandRunner(podmanBin);
  return Effect.succeed({
    version: runner.version.pipe(
      Effect.mapError((cause) => bundledPodmanLaunchError(platform, podmanBin, cause)),
    ),
  });
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
  if (platform === "win32") {
    const normalizedRuntimeBinDir = runtimeBinDir.replace(/[\\/]+$/u, "");
    const missingHelper = WINDOWS_MACHINE_HELPERS.find(
      (helper) => !(options._machineToolingExists ?? existsSync)(`${normalizedRuntimeBinDir}/${helper}`),
    );
    if (missingHelper !== undefined) return Effect.fail(missingBundledMachineHelperError(missingHelper));
  }

  const factory = options._machineRunnerFactory ?? makeSystemPodmanMachineRunner;
  return Effect.succeed(factory(podmanBin, MANAGED_MACHINE_NAME, platform));
};

export const ensureMacOSPodmanMachine = (
  machine: PodmanMachineRunner,
  recordedOwnership?: RecordedMachineOwnership,
  onCreated: Effect.Effect<void, ProviderUnavailableError> = Effect.void,
): Effect.Effect<{ readonly createdByLando: boolean }, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* onCreated;
      yield* machine.start;
      return { createdByLando: true };
    }
    const trust =
      recordedOwnership === undefined
        ? resolveMachineTrustImport({ status })
        : resolveMachineTrustImport({ status, recordedOwnership });
    if (status === "running") {
      return { createdByLando: false };
    }
    if (trust.kind === "import" && trust.mode === "manage") {
      yield* machine.syncTrust ?? Effect.void;
    }
    yield* machine.start;
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
  recordedOwnership?: RecordedMachineOwnership,
  onCreated: Effect.Effect<void, ProviderUnavailableError> = Effect.void,
): Effect.Effect<{ readonly createdByLando: boolean }, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const status = yield* machine.inspect;
    if (status === "missing") {
      yield* machine.create;
      yield* onCreated;
      yield* machine.start;
      return { createdByLando: true };
    }
    const trust =
      recordedOwnership === undefined
        ? resolveMachineTrustImport({ status })
        : resolveMachineTrustImport({ status, recordedOwnership });
    if (status === "running") {
      return { createdByLando: false };
    }
    if (trust.kind === "import" && trust.mode === "manage") {
      yield* machine.syncTrust ?? Effect.void;
    }
    yield* machine.start;
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

export const persistSetupState = (
  stateDir: string,
  state: {
    readonly podmanVersion: string;
    readonly runtimeBundleVersion?: string;
    readonly runtimeBundleSha256?: string;
    readonly runtimeBinDir?: string;
    readonly socketPath?: string;
    readonly machine?: RecordedMachineOwnership;
  },
  renameState: (from: string, to: string) => Promise<void> = rename,
) =>
  Effect.tryPromise({
    try: async () => {
      const providerDir = `${stateDir.replace(/\/+$/u, "")}/provider-lando`;
      const statePath = providerStatePath(stateDir);
      const tempPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;

      await mkdir(providerDir, { recursive: true });
      try {
        await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await renameState(tempPath, statePath);
      } finally {
        await rm(tempPath, { force: true });
      }

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

const publishWarn = (
  eventService: ProgressEmitter | undefined,
  event: typeof MessageWarnEvent.Type,
): Effect.Effect<void> =>
  eventService === undefined ? Effect.void : eventService.publish(event).pipe(Effect.ignore);

interface SetupStep {
  readonly taskId: string;
  readonly label: string;
}

const buildSetupSteps = (
  family: HostPlatformFamily,
  hasBundle: boolean,
  hasStateDir: boolean,
  probesSocket: boolean,
  managesRuntime: boolean,
  smoke: boolean,
): ReadonlyArray<SetupStep> => {
  const steps: SetupStep[] = [];
  if (hasBundle) steps.push({ taskId: "bundle", label: "Verify runtime bundle" });
  steps.push({ taskId: "podman", label: "Detect Podman" });
  if (family === "darwin" || family === "win32")
    steps.push({ taskId: "machine", label: "Ensure Podman machine" });
  if (probesSocket) steps.push({ taskId: "socket", label: "Probe Podman API" });
  if (managesRuntime) {
    if (family === "linux")
      steps.push({ taskId: "prerequisites", label: "Provision and preflight runtime prerequisites" });
    steps.push({ taskId: "launch", label: "Launch managed runtime" });
    steps.push({ taskId: "readiness", label: "Verify managed runtime readiness" });
    if (smoke) steps.push({ taskId: "smoke", label: "Verify managed runtime operations" });
  }
  if (hasStateDir) steps.push({ taskId: "state", label: "Persist setup state" });
  return steps;
};

const failureMessage = (cause: unknown): string =>
  cause instanceof ProviderUnavailableError || cause instanceof Error ? cause.message : String(cause);

const failureDetails = (
  cause: Cause.Cause<unknown>,
): { readonly summary: string; readonly remediation?: string } => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    return {
      summary: failureMessage(failure.value),
      ...(failure.value instanceof ProviderUnavailableError && failure.value.remediation !== undefined
        ? { remediation: failure.value.remediation }
        : {}),
    };
  }
  if (Cause.isInterruptedOnly(cause)) return { summary: "Setup interrupted." };
  const defect = Cause.dieOption(cause);
  return {
    summary: defect._tag === "Some" ? failureMessage(defect.value) : Cause.pretty(cause),
  };
};

const withStep = <A, E>(
  tree: TaskTreeController,
  step: SetupStep,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* tree.startTask(step.taskId);
    const result = yield* body.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        const details = failureDetails(exit.cause);
        return tree.failTask(
          step.taskId,
          details.summary,
          details.remediation === undefined ? undefined : { remediation: details.remediation },
        );
      }),
    );
    yield* tree.completeTask(step.taskId, step.label);
    return result;
  });

export const setupProviderLando = (options: SetupOptions): Effect.Effect<SetupResult, ProviderError> =>
  Effect.gen(function* () {
    const platform = options.platform;
    const family = hostPlatformFamily(platform);
    const arch = options.arch;
    yield* rejectIntelMacHost(platform, arch);
    const hasBundle = options.runtimeBundleDownloader !== undefined;
    const hasStateDir = options.stateDir !== undefined;
    const probesSocket = options.skipSocketProbe !== true;
    const managesRuntime = options.managedRuntimeSetup !== undefined;
    const steps = buildSetupSteps(
      family,
      hasBundle,
      hasStateDir,
      probesSocket,
      managesRuntime,
      options.smoke === true,
    );
    const tree = makeTaskTree(options.eventService, {
      parentId: SETUP_PARENT_ID,
      label: "Setting up Lando runtime",
      children: steps.map((step) => ({ id: step.taskId, label: step.label })),
      mode: "list",
    });

    yield* tree.start;

    const bundleStep = steps.find((step) => step.taskId === "bundle");
    const podmanStep = steps.find((step) => step.taskId === "podman");
    const machineStep = steps.find((step) => step.taskId === "machine");
    const socketStep = steps.find((step) => step.taskId === "socket");
    const stateStep = steps.find((step) => step.taskId === "state");

    if (podmanStep === undefined || (probesSocket && socketStep === undefined)) {
      return yield* Effect.die("internal: missing required setup steps");
    }

    const result = yield* Effect.gen(function* () {
      const runtimeBinDir = options.runtimeBinDir;
      const runtimeConfigDir = options.runtimeConfigDir;
      let machineOwnership: RecordedMachineOwnership | undefined;
      const existingMachineOwnership =
        options.stateDir === undefined || (family !== "darwin" && family !== "win32")
          ? undefined
          : yield* readExistingMachineOwnership(options.stateDir, options.eventService);
      const bundle =
        bundleStep === undefined || options.runtimeBundleDownloader === undefined
          ? undefined
          : yield* withStep(
              tree,
              bundleStep,
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

      if (family === "linux" && runtimeBinDir !== undefined && options.nftArtifactDownload !== undefined) {
        yield* ensureManagedNft({
          runtimeBinDir,
          download: options.nftArtifactDownload,
          cacheDir:
            options.nftCacheDir ??
            `${(options.stateDir ?? runtimeBinDir).replace(/\/+$/u, "")}/nft-downloads`,
          platform,
          arch: arch ?? process.arch,
        });
      }

      const podmanVersionOutput = yield* withStep(
        tree,
        podmanStep,
        (options.podmanCommand !== undefined
          ? options.podmanCommand.version
          : resolveSetupPodmanCommandRunner(
              platform,
              options.runtimeBinDir,
              options._machineToolingExists ?? existsSync,
            ).pipe(Effect.flatMap((runner) => runner.version))
        ).pipe(Effect.tap((output) => enforcePodmanVersionFloor(parsePodmanVersion(output), "cli"))),
      );
      const detectedPodmanVersion = parsePodmanVersion(podmanVersionOutput);
      const socketPath = options.socketPath;
      const recordCreatedMachine = (runner: PodmanMachineRunner) =>
        createdMachineOwnership(runner).pipe(
          Effect.tap((ownership) =>
            Effect.sync(() => {
              machineOwnership = ownership;
            }),
          ),
          Effect.flatMap((ownership) =>
            options.stateDir === undefined
              ? Effect.void
              : persistSetupState(options.stateDir, {
                  podmanVersion: detectedPodmanVersion,
                  ...(bundle === undefined
                    ? {}
                    : { runtimeBundleVersion: bundle.version, runtimeBundleSha256: bundle.sha256 }),
                  ...(bundle !== undefined && runtimeBinDir !== undefined ? { runtimeBinDir } : {}),
                  ...(socketPath === undefined ? {} : { socketPath }),
                  machine: ownership,
                }).pipe(Effect.asVoid),
          ),
        );

      if (family === "darwin" && machineStep !== undefined) {
        yield* withStep(
          tree,
          machineStep,
          resolveSetupMachineRunner("darwin", options).pipe(
            Effect.flatMap((runner) =>
              Effect.gen(function* () {
                const ownership = yield* verifyRecordedMachineOwnership(existingMachineOwnership, runner);
                const trusted =
                  ownership?.createdByLando === true && ownership.createdAt !== undefined
                    ? ownership
                    : undefined;
                const ensured = yield* ensureMacOSPodmanMachine(
                  runner,
                  trusted,
                  recordCreatedMachine(runner),
                );
                if (!ensured.createdByLando) {
                  machineOwnership = ownership ?? { name: "lando", createdByLando: false };
                }
              }),
            ),
          ),
        );
      }

      if (family === "win32" && machineStep !== undefined) {
        yield* withStep(
          tree,
          machineStep,
          resolveSetupMachineRunner("win32", options).pipe(
            Effect.flatMap((runner) =>
              Effect.gen(function* () {
                const ownership = yield* verifyRecordedMachineOwnership(existingMachineOwnership, runner);
                const trusted =
                  ownership?.createdByLando === true && ownership.createdAt !== undefined
                    ? ownership
                    : undefined;
                const ensured = yield* ensureWindowsPodmanMachine(
                  runner,
                  trusted,
                  recordCreatedMachine(runner),
                );
                if (
                  (ensured.createdByLando || trusted !== undefined) &&
                  runner.activateApiSocket !== undefined
                ) {
                  yield* runner.activateApiSocket;
                }
                if (!ensured.createdByLando) {
                  machineOwnership = ownership ?? { name: "lando", createdByLando: false };
                }
              }),
            ),
          ),
        );
      }

      const api =
        options.podmanApi ??
        (socketPath === undefined ? undefined : makeRuntimePodmanApiClient(socketPath, LANDO_CTX));

      let info: unknown;
      if (probesSocket && socketStep !== undefined) {
        info = yield* withStep(
          tree,
          socketStep,
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

      const podmanVersion = infoPodmanVersion(info) ?? detectedPodmanVersion;
      if (options.managedRuntimeSetup !== undefined) {
        const progress: RuntimeSetupProgress = {
          ...(bundle === undefined ? {} : { runtimeBundleVersion: bundle.version }),
          run: (phase, body) => {
            const step = steps.find((candidate) => candidate.taskId === phase);
            return step === undefined
              ? Effect.die(`internal: missing managed runtime setup step ${phase}`)
              : withStep(tree, step, body);
          },
        };
        yield* options.managedRuntimeSetup(progress);
      } else {
        yield* options.readinessCheck ?? Effect.void;
      }
      const statePath =
        stateStep === undefined || options.stateDir === undefined
          ? undefined
          : yield* withStep(
              tree,
              stateStep,
              persistSetupState(options.stateDir, {
                podmanVersion,
                ...(bundle === undefined
                  ? {}
                  : { runtimeBundleVersion: bundle.version, runtimeBundleSha256: bundle.sha256 }),
                ...(bundle !== undefined && runtimeBinDir !== undefined ? { runtimeBinDir } : {}),
                ...(socketPath === undefined ? {} : { socketPath }),
                ...(machineOwnership === undefined ? {} : { machine: machineOwnership }),
              }),
            );

      return {
        podmanVersion,
        ...(bundle === undefined ? {} : { runtimeBundleVersion: bundle.version }),
        ...(bundle !== undefined && runtimeBinDir !== undefined ? { runtimeBinDir } : {}),
        ...(statePath === undefined ? {} : { statePath }),
      } satisfies SetupResult;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const details = failureDetails(exit.cause);
              for (const step of steps) {
                yield* tree.failTask(
                  step.taskId,
                  details.summary,
                  details.remediation === undefined ? undefined : { remediation: details.remediation },
                );
              }
              yield* tree.close("Lando runtime setup failed");
            }),
      ),
    );

    yield* tree.close("Lando runtime ready");

    return result;
  });

export { MINIMUM_PODMAN_VERSION };
