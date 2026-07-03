import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export const classifyManagedProviderMachine = (
  userDataRoot: string,
  readFileSyncSeam: (path: string) => string = (path) => readFileSync(path, "utf8"),
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

  if (typeof parsed !== "object" || parsed === null || !("machine" in parsed)) {
    return { ownership: "absent" };
  }
  const machine = (parsed as { readonly machine: unknown }).machine;
  if (typeof machine !== "object" || machine === null) return { ownership: "absent" };

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

// Podman returns exit code 125 when the target machine does not exist. Removing an
// already-gone machine is the idempotent no-op that lets a rerun converge.
const PODMAN_MACHINE_NOT_FOUND_EXIT = 125;

const defaultSpawn = async (args: ReadonlyArray<string>): Promise<MachineSpawnResult> => {
  const proc = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
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
  if (result.exitCode === PODMAN_MACHINE_NOT_FOUND_EXIT) return { removed: false, name };

  throw new Error(
    `Failed to remove the managed Podman machine "${name}". Run 'podman machine rm --force ${name}' manually. (exit ${result.exitCode}: ${result.stderr.trim()})`,
  );
};
