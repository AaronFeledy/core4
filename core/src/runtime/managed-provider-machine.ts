import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HostPlatform } from "@lando/sdk/schema";

import { normalizeHostPlatform } from "../config/paths.ts";

// Ownership of the managed provider machine (the macOS/Windows Podman VM), derived
// solely from the provider's recorded setup-state. This module deliberately does NOT
// import @lando/provider-lando: it only mirrors the setup-state path convention and the
// `podman machine rm` argv, keeping the provider plugin out of the CLI cold-start graph.
export type ManagedProviderMachineOwnership = "owned" | "not-owned" | "ambiguous" | "absent";

export interface ManagedProviderMachineClassification {
  readonly ownership: ManagedProviderMachineOwnership;
  readonly name?: string;
}

// The only machine name Lando manages today. Any other recorded name is treated as
// ambiguous so uninstall never removes a machine Lando did not create.
const MANAGED_MACHINE_NAME = "lando";

const setupStatePath = (userDataRoot: string): string =>
  join(userDataRoot, "providers", "provider-lando", "setup-state.json");

const hasEnoentCode = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const readSetupState = (
  userDataRoot: string,
  readFileSyncSeam: (path: string) => string,
):
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "text"; readonly text: string } => {
  try {
    return { kind: "text", text: readFileSyncSeam(setupStatePath(userDataRoot)) };
  } catch (cause) {
    return hasEnoentCode(cause) ? { kind: "absent" } : { kind: "unreadable" };
  }
};

// Hosts where Lando setup can create/own a Podman machine (VM). Linux (and WSL, which
// runs Podman natively inside the distro) never records one, so a missing "machine"
// field there is unambiguously "no machine to manage" rather than legacy state.
const machineManagingPlatforms: ReadonlySet<HostPlatform> = new Set(["darwin", "win32"]);

export const classifyManagedProviderMachine = (
  userDataRoot: string,
  readFileSyncSeam: (path: string) => string = (path) => readFileSync(path, "utf8"),
  platform: HostPlatform = normalizeHostPlatform(),
): ManagedProviderMachineClassification => {
  const state = readSetupState(userDataRoot, readFileSyncSeam);
  if (state.kind === "absent") return { ownership: "absent" };
  if (state.kind === "unreadable") return { ownership: "ambiguous" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(state.text);
  } catch {
    return { ownership: "ambiguous" };
  }

  const machine =
    typeof parsed === "object" && parsed !== null && "machine" in parsed
      ? (parsed as { readonly machine: unknown }).machine
      : undefined;

  if (typeof machine !== "object" || machine === null) {
    // Setup state exists but carries no recognizable machine record. On a platform
    // that manages a Podman machine this can be legacy state recorded before
    // ownership tracking existed, so guessing "absent" could silently skip uninstall
    // guidance for a VM that is still on disk; require manual review instead.
    return machineManagingPlatforms.has(platform) ? { ownership: "ambiguous" } : { ownership: "absent" };
  }

  const name = "name" in machine ? (machine as { readonly name: unknown }).name : undefined;
  const createdByLando =
    "createdByLando" in machine
      ? (machine as { readonly createdByLando: unknown }).createdByLando
      : undefined;

  if (name !== MANAGED_MACHINE_NAME || typeof createdByLando !== "boolean") {
    return { ownership: "ambiguous" };
  }

  return { ownership: createdByLando ? "owned" : "not-owned", name: MANAGED_MACHINE_NAME };
};

export interface MachineSpawnResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface MachineTeardownSeams {
  readonly spawn?: (args: ReadonlyArray<string>) => Promise<MachineSpawnResult>;
  readonly classify?: (userDataRoot: string) => ManagedProviderMachineClassification;
}

// Podman returns exit code 125 when the target machine does not exist, but it also
// uses 125 for other failures, so treat it as "already gone" only when stderr says so.
const PODMAN_MACHINE_NOT_FOUND_EXIT = 125;
const PODMAN_MACHINE_NOT_FOUND_PATTERN = /not\s*(exist|found)|no such|cannot find/i;

const defaultSpawn = async (args: ReadonlyArray<string>): Promise<MachineSpawnResult> => {
  const proc = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  // Drain stdout alongside stderr: an unread stdout pipe can fill and block podman's
  // write, hanging `proc.exited` forever once the child has enough output to write.
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
};

export const teardownManagedProviderMachine = async (
  userDataRoot: string,
  seams: MachineTeardownSeams = {},
): Promise<{ readonly removed: boolean; readonly name?: string }> => {
  const classify = seams.classify ?? classifyManagedProviderMachine;
  const classification = classify(userDataRoot);
  const name = classification.name;
  // TOCTOU defense: only ever remove a machine whose recorded ownership is explicitly
  // Lando-created, and only under the managed name.
  if (classification.ownership !== "owned" || name !== MANAGED_MACHINE_NAME) {
    return { removed: false };
  }

  const spawn = seams.spawn ?? defaultSpawn;
  const result = await spawn(["machine", "rm", "--force", name]);
  if (result.exitCode === 0) return { removed: true, name };
  if (
    result.exitCode === PODMAN_MACHINE_NOT_FOUND_EXIT &&
    PODMAN_MACHINE_NOT_FOUND_PATTERN.test(result.stderr)
  ) {
    return { removed: false, name };
  }

  throw new Error(
    `Failed to remove the managed Podman machine "${name}". Run 'podman machine rm --force ${name}' manually. (exit ${result.exitCode}: ${result.stderr.trim()})`,
  );
};
