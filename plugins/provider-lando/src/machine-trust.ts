import type { PodmanMachineStatus } from "./setup.ts";

/**
 * Managed-machine CA trust seam.
 *
 * This is a pure, future-implementation seam (mirrors {@link ./image-pull.ts}
 * and {@link ./volume-prune.ts}): it models the argv and the trust-import
 * decision a real macOS/Windows machine driver will consult, without wiring a
 * live machine lifecycle (the host has no Podman machine to create).
 *
 * `--import-native-ca` is a boolean Podman flag (default `false`, supported on
 * macOS, Windows, and Linux) that syncs the host's native CA trust store into
 * the machine on startup. Because the flag takes no value, the argv it produces
 * carries no local certificate path or other host-specific detail — the trust
 * import never leaks host state into command output.
 */

/** The boolean Podman flag that imports the host's native CA trust store. */
export const IMPORT_NATIVE_CA_FLAG = "--import-native-ca" as const;

/**
 * Build the `podman machine init` argv for a Lando-owned machine, importing the
 * host's native CA trust on creation. The boolean flag precedes the machine
 * name positional, matching Podman's documented invocation.
 */
export const buildManagedMachineInitArgs = (machineName: string): ReadonlyArray<string> => [
  "machine",
  "init",
  IMPORT_NATIVE_CA_FLAG,
  machineName,
];

/**
 * Build the `podman machine set` argv that (re)enables native CA import on an
 * existing Lando-owned machine. Used when managing a machine Lando already
 * created, rather than re-initializing it.
 */
export const buildManagedMachineTrustSyncArgs = (machineName: string): ReadonlyArray<string> => [
  "machine",
  "set",
  IMPORT_NATIVE_CA_FLAG,
  machineName,
];

/** The recorded ownership state anchored in the provider-lando setup state. */
export interface RecordedMachineOwnership {
  readonly createdByLando: boolean;
}

/** Input for {@link resolveMachineTrustImport}. */
export interface MachineTrustInput {
  readonly status: PodmanMachineStatus;
  readonly recordedOwnership?: RecordedMachineOwnership;
}

/**
 * The trust-import decision. Lando imports native CA trust only into machines
 * it owns: a machine it is about to create (`mode: "create"`) or an existing
 * machine it previously created (`mode: "manage"`). A machine Lando did not
 * create is user-owned and is never modified implicitly (`kind: "skip"`).
 */
export type MachineTrustDecision =
  | { readonly kind: "import"; readonly mode: "create" | "manage" }
  | { readonly kind: "skip"; readonly reason: "user-owned" };

/**
 * Decide whether Lando may import native CA trust for the managed machine.
 *
 * - A missing machine will be created by Lando, making it Lando-owned, so trust
 *   is imported at creation regardless of any stale ownership record.
 * - An existing machine is trusted only when the recorded ownership proves
 *   Lando created it; otherwise it is treated as user-owned and left untouched.
 */
export const resolveMachineTrustImport = (input: MachineTrustInput): MachineTrustDecision => {
  if (input.status === "missing") {
    return { kind: "import", mode: "create" };
  }
  if (input.recordedOwnership?.createdByLando === true) {
    return { kind: "import", mode: "manage" };
  }
  return { kind: "skip", reason: "user-owned" };
};

/**
 * Windows Hyper-V remediation text. Lando reports the manual prep step as
 * guidance and never auto-elevates or runs it: `podman system hyperv-prep`
 * requires administrator privileges, so the user must run it themselves in an
 * elevated terminal. The text carries only command names, never host paths.
 */
export const windowsHyperVPrepRemediation = (): string =>
  "Windows requires Hyper-V, WSL2, and the Virtual Machine Platform for Podman machines. " +
  "Preparing Hyper-V needs administrator privileges, so Lando never runs it or elevates for you. " +
  "In an elevated (Run as administrator) terminal run `podman system hyperv-prep`, then rerun `lando setup`.";
